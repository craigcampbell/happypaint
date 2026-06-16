import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { createDefaultFrames, DEFAULT_FRAME_DURATION_MS, DEFAULT_SETTINGS } from "./src/constants";
import { makeId } from "./src/ids";
import { AiAssistScreen } from "./src/components/AiAssistScreen";
import { BrushStudioScreen } from "./src/components/BrushStudioScreen";
import { CreatorDashboardScreen } from "./src/components/CreatorDashboardScreen";
import { DiscoverScreen } from "./src/components/DiscoverScreen";
import { GalleryScreen } from "./src/components/GalleryScreen";
import { PaintSpaceScreen } from "./src/components/PaintSpaceScreen";
import { ReplayScreen } from "./src/components/ReplayScreen";
import { SettingsScreen } from "./src/components/SettingsScreen";
import { StoreScreen } from "./src/components/StoreScreen";
import { StudioScreen } from "./src/components/StudioScreen";
import { TogetherScreen } from "./src/components/TogetherScreen";
import { WalletScreen } from "./src/components/WalletScreen";
import {
  creditDrops,
  emptyState,
  hasEntitlement,
  loadEconomy,
  migrateLegacyStudioPass,
  saveEconomy,
  sendTip,
  spendDrops,
  type DropProduct,
  type EconomyState,
  type StoreItem
} from "./src/economy";
import { loadSpaceAssets } from "./src/paintSpace";
import { recipeToBrushSettings } from "./src/brushStudio";
import { clearReplaySnapshots } from "./src/replay";
import {
  copyImportAsync,
  deleteProject,
  ensureStorageReady,
  loadProjects,
  loadStoredSettings,
  saveProject,
  saveStoredSettings,
} from "./src/storage";
import type {
  BrushRecipe,
  BrushSettings,
  DrawingProject,
  Frame,
  LoopPayload,
  PalettePayload,
  SpaceAsset,
  StickerPayload,
  TemplatePayload,
  ToolMode
} from "./src/types";

type AppSettings = BrushSettings & {
  calmMode: boolean;
  premiumPreview: boolean;
};

const INITIAL_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  calmMode: true,
  premiumPreview: false
};

function makeProject(): DrawingProject {
  const now = Date.now();
  const frames = createDefaultFrames();
  return {
    id: makeId("project"),
    title: `Painting ${new Date(now).toLocaleDateString()}`,
    createdAt: now,
    updatedAt: now,
    texture: "linen",
    frames,
    activeFrameId: frames[0].id
  };
}

// Deep-copy a saved frame stack (fresh ids) so an applied template/loop is an
// independent project rather than sharing item identities with the asset.
function cloneFrames(frames: Frame[]): Frame[] {
  return frames.map((frame) => {
    const layers = frame.layers.map((layer) => {
      const newLayerId = makeId("layer");
      return {
        ...layer,
        id: newLayerId,
        items: layer.items.map((item) => ({ ...item, id: makeId(item.kind) }))
      };
    });
    const activeIndex = frame.layers.findIndex((l) => l.id === frame.activeLayerId);
    return {
      ...frame,
      id: makeId("frame"),
      durationMs: frame.durationMs || DEFAULT_FRAME_DURATION_MS,
      layers,
      activeLayerId: layers[activeIndex >= 0 ? activeIndex : 0]?.id ?? layers[0].id
    };
  });
}

function projectFromFrames(title: string, texture: DrawingProject["texture"], frames: Frame[]): DrawingProject {
  const now = Date.now();
  const cloned = frames.length > 0 ? cloneFrames(frames) : createDefaultFrames();
  return {
    id: makeId("project"),
    title,
    createdAt: now,
    updatedAt: now,
    texture,
    frames: cloned,
    activeFrameId: cloned[0].id
  };
}

export default function App() {
  const [mode, setMode] = useState<ToolMode>("gallery");
  const [projects, setProjects] = useState<DrawingProject[]>([]);
  const [currentProject, setCurrentProject] = useState<DrawingProject | null>(null);
  const [settings, setSettings] = useState<AppSettings>(INITIAL_SETTINGS);
  const [economy, setEconomy] = useState<EconomyState>(emptyState);
  const [spaceAssets, setSpaceAssets] = useState<SpaceAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingJoinCode, setPendingJoinCode] = useState("");
  const [pendingSticker, setPendingSticker] = useState<StickerPayload | null>(null);
  const projectsRef = useRef<DrawingProject[]>([]);
  // Debounced persistence (M1a): rapid strokes mutate in-memory state every
  // commit but only write to disk on a trailing timer. `pendingSaveRef` always
  // holds the LATEST project to flush (avoids stale-closure writes).
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<DrawingProject | null>(null);
  const SAVE_DEBOUNCE_MS = 1000;

  useEffect(() => {
    let mounted = true;

    async function boot() {
      await ensureStorageReady();
      const [storedProjects, storedSettings, storedEconomy, storedAssets] = await Promise.all([
        loadProjects(),
        loadStoredSettings<AppSettings>(INITIAL_SETTINGS),
        loadEconomy(),
        loadSpaceAssets()
      ]);

      if (!mounted) {
        return;
      }

      // Migrate the legacy `premiumPreview` flag (the old "Drops preview"
      // placeholder) into a real mock entitlement: owning the Creator Brushes
      // pack + the "studio" entitlement, recorded honestly in the ledger. Then
      // clear the flag so the migration runs once.
      const migration = migrateLegacyStudioPass(storedEconomy, storedSettings.premiumPreview);
      let nextEconomy = migration.state;
      let nextSettings = storedSettings;
      if (migration.changed) {
        await saveEconomy(nextEconomy);
        nextSettings = { ...storedSettings, premiumPreview: false };
        await saveStoredSettings(nextSettings);
      }

      setProjects(storedProjects);
      projectsRef.current = storedProjects;
      setSettings(nextSettings);
      setEconomy(nextEconomy);
      setSpaceAssets(storedAssets);
      setLoading(false);
    }

    void boot();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const handleUrl = (url: string | null) => {
      if (!url) {
        return;
      }
      const code = url.split("/join/")[1]?.split(/[?#]/)[0]?.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (code) {
        setPendingJoinCode(code);
        setMode("together");
      }
    };

    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener("url", (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, []);

  // Write the latest pending project to disk and clear the timer. Always reads
  // the freshest snapshot from the ref so a debounced flush never persists a
  // stale closure value.
  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const project = pendingSaveRef.current;
    if (!project) {
      return;
    }
    pendingSaveRef.current = null;
    await saveProject(project);
  }, []);

  const persistProject = useCallback(
    (project: DrawingProject) => {
      // In-memory state updates immediately so the UI/gallery never lag.
      setCurrentProject(project);
      const nextProjects = [project, ...projectsRef.current.filter((item) => item.id !== project.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt
      );
      projectsRef.current = nextProjects;
      setProjects(nextProjects);

      // Disk write is debounced (trailing) and always flushes the latest project.
      pendingSaveRef.current = project;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushPendingSave();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushPendingSave]
  );

  // Flush on app background and on unmount so a debounced write is never lost.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        void flushPendingSave();
      }
    });
    return () => {
      subscription.remove();
      void flushPendingSave();
    };
  }, [flushPendingSave]);

  const updateSettings = useCallback(async (nextSettings: AppSettings) => {
    setSettings(nextSettings);
    await saveStoredSettings(nextSettings);
  }, []);

  // Refresh the Paint Space locker when opening the Creator dashboard so "My
  // packs" reflects assets saved since boot.
  useEffect(() => {
    if (mode !== "creator") {
      return;
    }
    let active = true;
    void loadSpaceAssets().then((assets) => {
      if (active) {
        setSpaceAssets(assets);
      }
    });
    return () => {
      active = false;
    };
  }, [mode]);

  // --- Economy actions (mock; no real payments / network) --------------------
  const persistEconomy = useCallback(async (next: EconomyState) => {
    setEconomy(next);
    await saveEconomy(next);
  }, []);

  // Mock "purchase" of a Drop product: credits Drops to the wallet ledger. A
  // real build would verify an App Store / Google Play receipt first.
  const buyDrops = useCallback(
    (product: DropProduct) => {
      const next = creditDrops(economy, product);
      void persistEconomy(next);
      Alert.alert("Drops added (preview)", `Credited ${product.drop_amount} Drops. No real charge was made.`);
    },
    [economy, persistEconomy]
  );

  // Spend Drops on a store item; blocked when the balance is insufficient,
  // idempotent once owned. Owning an item grants its entitlement.
  const buyItem = useCallback(
    (item: StoreItem) => {
      const result = spendDrops(economy, item);
      if (!result.ok) {
        if (result.reason === "insufficient") {
          Alert.alert("Not enough Drops", `${item.title} costs ${item.price_drops} Drops. Get more Drops to unlock it.`);
        }
        return;
      }
      void persistEconomy(result.state);
      Alert.alert("Unlocked", `${item.title} is now yours.`);
    },
    [economy, persistEconomy]
  );

  // Send a Drops tip; spend lands in the locked creator balance (Phase 1).
  const tipCreator = useCallback(
    (amount: number) => {
      const result = sendTip(economy, { amount, sourceType: "gallery_post", receiverName: "Creator" });
      if (!result.ok) {
        Alert.alert("Not enough Drops", `A ${amount} Drops tip needs more Drops in your wallet.`);
        return;
      }
      void persistEconomy(result.state);
      Alert.alert("Tip sent (preview)", `${amount} Drops moved into the locked creator balance.`);
    },
    [economy, persistEconomy]
  );

  const hasStudioTier = hasEntitlement(economy, "studio");

  const createProject = useCallback(async () => {
    const project = makeProject();
    persistProject(project);
    // A brand-new project has no strokes to trigger another save soon, so write
    // it through immediately rather than waiting on the debounce timer.
    await flushPendingSave();
    setMode("studio");
  }, [flushPendingSave, persistProject]);

  const openProject = useCallback(
    async (project: DrawingProject) => {
      const nextSettings = { ...settings, texture: project.texture };
      setCurrentProject(project);
      setSettings(nextSettings);
      await saveStoredSettings(nextSettings);
      setMode("studio");
    },
    [settings]
  );

  const confirmDelete = useCallback((project: DrawingProject) => {
    Alert.alert("Delete painting?", `${project.title} will be removed from this device.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteProject(project.id);
          // Also drop the artwork's replay snapshot series (index + files).
          await clearReplaySnapshots(project.id);
          const nextProjects = await loadProjects();
          projectsRef.current = nextProjects;
          setProjects(nextProjects);
          if (currentProject?.id === project.id) {
            setCurrentProject(null);
          }
        }
      }
    ]);
  }, [currentProject?.id]);

  // --- Paint Space apply flows ----------------------------------------------
  const applySticker = useCallback(
    (payload: StickerPayload) => {
      // Queue the sticker for the studio to drop on the active layer. If there
      // is no open project, start one first.
      setPendingSticker(payload);
      if (!currentProject) {
        void createProject();
      } else {
        setMode("studio");
      }
    },
    [createProject, currentProject]
  );

  const applyPalette = useCallback(
    async (payload: PalettePayload) => {
      const first = payload.colors[0];
      if (first) {
        const nextSettings = { ...settings, color: first };
        setSettings(nextSettings);
        await saveStoredSettings(nextSettings);
      }
      Alert.alert("Palette loaded", "The first color is now selected. Tap swatches in the studio to use the rest.");
      setMode(currentProject ? "studio" : "gallery");
    },
    [currentProject, settings]
  );

  const applyTemplate = useCallback(
    async (_assetId: string, payload: TemplatePayload) => {
      const project = projectFromFrames("From template", payload.texture, payload.frames);
      const nextSettings = { ...settings, texture: payload.texture };
      setSettings(nextSettings);
      await saveStoredSettings(nextSettings);
      persistProject(project);
      await flushPendingSave();
      setMode("studio");
    },
    [flushPendingSave, persistProject, settings]
  );

  const applyLoop = useCallback(
    async (_assetId: string, payload: LoopPayload) => {
      const project = projectFromFrames("From loop", payload.texture, payload.frames);
      const nextSettings = { ...settings, texture: payload.texture };
      setSettings(nextSettings);
      await saveStoredSettings(nextSettings);
      persistProject(project);
      await flushPendingSave();
      setMode("studio");
    },
    [flushPendingSave, persistProject, settings]
  );

  // --- Replay: remix a snapshot into a new artwork ---------------------------
  // The snapshot is a flattened composite PNG. Start a fresh project and place
  // the snapshot as the imported tracing reference (reuses the import path),
  // copying it into the new project's own import file so it survives.
  const remixFromSnapshot = useCallback(
    async (uri: string, sourceTitle: string) => {
      const project = makeProject();
      project.title = `Remix of ${sourceTitle}`;
      try {
        project.importedImageUri = await copyImportAsync(uri, project.id);
      } catch {
        project.importedImageUri = uri;
      }
      persistProject(project);
      await flushPendingSave();
      setMode("studio");
    },
    [flushPendingSave, persistProject]
  );

  // --- Event Engine: enter the studio for an event/daily prompt --------------
  // Opens the studio with a project (creating one if needed). The prompt is
  // surfaced to the user; seeding it onto the canvas is a later enhancement.
  const enterStudioForPrompt = useCallback(
    async (prompt: string) => {
      if (prompt) {
        Alert.alert("Today's prompt", prompt);
      }
      if (!currentProject) {
        await createProject();
      } else {
        setMode("studio");
      }
    },
    [createProject, currentProject]
  );

  // --- AI Assist apply flows -------------------------------------------------
  // Apply a generated palette: first color becomes the active brush color.
  const applyAiPalette = useCallback(
    async (colors: string[]) => {
      const first = colors[0];
      if (first) {
        const nextSettings = { ...settings, color: first };
        setSettings(nextSettings);
        await saveStoredSettings(nextSettings);
      }
      Alert.alert("Palette ready", "The first color is selected. Pick the rest from the studio swatches.");
      setMode(currentProject ? "studio" : "gallery");
    },
    [currentProject, settings]
  );

  // Apply a brush recipe (from AI Assist) to the live BrushSettings.
  const applyBrushRecipe = useCallback(
    async (recipe: BrushRecipe) => {
      const patch = recipeToBrushSettings(recipe);
      const nextSettings = { ...settings, ...patch };
      setSettings(nextSettings);
      await saveStoredSettings(nextSettings);
    },
    [settings]
  );

  // Apply a brush settings patch (from Brush Studio) to the live BrushSettings.
  const applyBrushPatch = useCallback(
    async (patch: Partial<BrushSettings>) => {
      const nextSettings = { ...settings, ...patch };
      setSettings(nextSettings);
      await saveStoredSettings(nextSettings);
    },
    [settings]
  );

  // After in-app account deletion wiped all local data, reset every in-memory
  // store back to a fresh first-launch state and return to an empty gallery.
  // (The deletion helper already cleared AsyncStorage + the on-disk files.)
  const handleDataWiped = useCallback(() => {
    // Cancel any pending debounced save so it can't re-create a project file
    // after the wipe.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
    projectsRef.current = [];
    setProjects([]);
    setCurrentProject(null);
    setSettings(INITIAL_SETTINGS);
    setEconomy(emptyState());
    setSpaceAssets([]);
    setPendingSticker(null);
    setPendingJoinCode("");
    setMode("gallery");
  }, []);

  if (loading) {
    return (
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.loading}>
            <ActivityIndicator color="#0f766e" />
            <Text style={styles.loadingText}>Opening Happy Paint</Text>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.app}>
        {mode === "gallery" ? (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <GalleryScreen
              onCreate={createProject}
              onDelete={confirmDelete}
              onDiscover={() => setMode("discover")}
              onOpen={openProject}
              onSettings={() => setMode("settings")}
              onTogether={() => setMode("together")}
              projects={projects}
            />
          </ScrollView>
        ) : null}

        {mode === "studio" && currentProject ? (
          <StudioScreen
            calmMode={settings.calmMode}
            onBack={() => {
              // Flush any debounced save before leaving so the latest strokes
              // are on disk when the gallery re-reads from storage.
              void flushPendingSave();
              setMode("gallery");
            }}
            hasStudioTier={hasStudioTier}
            onOpenPaintSpace={() => setMode("paintspace")}
            onOpenSettings={() => setMode("settings")}
            onOpenStore={() => setMode("store")}
            onProjectChange={persistProject}
            onSettingsChange={(next) => void updateSettings({ ...settings, ...next })}
            onStickerConsumed={() => setPendingSticker(null)}
            onOpenReplay={() => setMode("replay")}
            onOpenAiAssist={() => setMode("aiassist")}
            onOpenBrushStudio={() => setMode("brushstudio")}
            pendingSticker={pendingSticker}
            project={currentProject}
            settings={settings}
          />
        ) : null}

        {mode === "replay" && currentProject ? (
          <ReplayScreen
            onBack={() => setMode("studio")}
            onRemixFromSnapshot={(uri, sourceTitle) => void remixFromSnapshot(uri, sourceTitle)}
            project={currentProject}
          />
        ) : null}

        {mode === "aiassist" ? (
          <AiAssistScreen
            onApplyPalette={(colors) => void applyAiPalette(colors)}
            onApplyRecipe={(recipe) => void applyBrushRecipe(recipe)}
            onBack={() => setMode(currentProject ? "studio" : "gallery")}
          />
        ) : null}

        {mode === "brushstudio" ? (
          <BrushStudioScreen
            color={settings.color}
            onApplyRecipe={(patch) => void applyBrushPatch(patch)}
            onBack={() => setMode(currentProject ? "studio" : "gallery")}
          />
        ) : null}

        {mode === "paintspace" ? (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <PaintSpaceScreen
              onApplyLoop={(_asset, payload) => void applyLoop(_asset.id, payload)}
              onApplyPalette={(payload) => void applyPalette(payload)}
              onApplySticker={applySticker}
              onApplyTemplate={(_asset, payload) => void applyTemplate(_asset.id, payload)}
              onBack={() => setMode(currentProject ? "studio" : "gallery")}
            />
          </ScrollView>
        ) : null}

        {mode === "settings" ? (
          <SettingsScreen
            calmMode={settings.calmMode}
            dropsBalance={economy.wallet.drops_balance}
            isChildAccount={economy.profile_kind === "child"}
            onBack={() => setMode(currentProject ? "studio" : "gallery")}
            onDataWiped={handleDataWiped}
            onOpenCreator={() => setMode("creator")}
            onOpenStore={() => setMode("store")}
            onOpenWallet={() => setMode("wallet")}
            onToggleCalm={(calmMode) => void updateSettings({ ...settings, calmMode })}
          />
        ) : null}

        {mode === "wallet" ? (
          <WalletScreen economy={economy} onBack={() => setMode("settings")} onOpenStore={() => setMode("store")} />
        ) : null}

        {mode === "store" ? (
          <StoreScreen
            economy={economy}
            onBack={() => setMode(currentProject ? "studio" : "settings")}
            onBuyDrops={buyDrops}
            onBuyItem={buyItem}
            onSendTip={tipCreator}
          />
        ) : null}

        {mode === "creator" ? (
          <CreatorDashboardScreen
            economy={economy}
            paintSpaceAssets={spaceAssets}
            onBack={() => setMode("settings")}
            onOpenWallet={() => setMode("wallet")}
          />
        ) : null}

        {mode === "together" ? (
          <TogetherScreen initialJoinCode={pendingJoinCode} onBack={() => setMode("gallery")} />
        ) : null}

        {mode === "discover" ? (
          <DiscoverScreen
            onBack={() => setMode("gallery")}
            onEnterStudio={(prompt) => void enterStudioForPrompt(prompt)}
            onTogether={() => setMode("together")}
          />
        ) : null}
      </View>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  app: {
    backgroundColor: "#eef6f4",
    flex: 1
  },
  loading: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center"
  },
  root: {
    flex: 1
  },
  loadingText: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "800"
  },
  safeArea: {
    backgroundColor: "#eef6f4",
    flex: 1
  },
  scrollBody: {
    flexGrow: 1
  }
});
