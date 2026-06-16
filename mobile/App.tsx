import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { createDefaultFrames, DEFAULT_FRAME_DURATION_MS, DEFAULT_SETTINGS } from "./src/constants";
import { makeId } from "./src/ids";
import { DiscoverScreen } from "./src/components/DiscoverScreen";
import { GalleryScreen } from "./src/components/GalleryScreen";
import { PaintSpaceScreen } from "./src/components/PaintSpaceScreen";
import { SettingsScreen } from "./src/components/SettingsScreen";
import { StudioScreen } from "./src/components/StudioScreen";
import { TogetherScreen } from "./src/components/TogetherScreen";
import {
  deleteProject,
  ensureStorageReady,
  loadProjects,
  loadStoredSettings,
  saveProject,
  saveStoredSettings,
} from "./src/storage";
import type {
  BrushSettings,
  DrawingProject,
  Frame,
  LoopPayload,
  PalettePayload,
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
      const [storedProjects, storedSettings] = await Promise.all([
        loadProjects(),
        loadStoredSettings<AppSettings>(INITIAL_SETTINGS)
      ]);

      if (!mounted) {
        return;
      }

      setProjects(storedProjects);
      projectsRef.current = storedProjects;
      setSettings(storedSettings);
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
            onOpenPaintSpace={() => setMode("paintspace")}
            onOpenSettings={() => setMode("settings")}
            onProjectChange={persistProject}
            onSettingsChange={(next) => void updateSettings({ ...settings, ...next })}
            onStickerConsumed={() => setPendingSticker(null)}
            pendingSticker={pendingSticker}
            premiumPreview={settings.premiumPreview}
            project={currentProject}
            settings={settings}
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
            onBack={() => setMode(currentProject ? "studio" : "gallery")}
            onToggleCalm={(calmMode) => void updateSettings({ ...settings, calmMode })}
            onTogglePremiumPreview={(premiumPreview) => void updateSettings({ ...settings, premiumPreview })}
            premiumPreview={settings.premiumPreview}
          />
        ) : null}

        {mode === "together" ? (
          <TogetherScreen initialJoinCode={pendingJoinCode} onBack={() => setMode("gallery")} />
        ) : null}

        {mode === "discover" ? (
          <DiscoverScreen onBack={() => setMode("gallery")} onTogether={() => setMode("together")} />
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
