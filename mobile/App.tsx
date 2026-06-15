import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";

import { DEFAULT_SETTINGS } from "./src/constants";
import { DiscoverScreen } from "./src/components/DiscoverScreen";
import { GalleryScreen } from "./src/components/GalleryScreen";
import { SettingsScreen } from "./src/components/SettingsScreen";
import { StudioScreen } from "./src/components/StudioScreen";
import { TogetherScreen } from "./src/components/TogetherScreen";
import {
  deleteProject,
  ensureStorageReady,
  loadProjects,
  loadStoredSettings,
  saveProjects,
  saveStoredSettings,
} from "./src/storage";
import type { BrushSettings, DrawingProject, ToolMode } from "./src/types";

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
  return {
    id: `project-${now}-${Math.random().toString(36).slice(2)}`,
    title: `Painting ${new Date(now).toLocaleDateString()}`,
    createdAt: now,
    updatedAt: now,
    texture: "linen",
    strokes: []
  };
}

export default function App() {
  const [mode, setMode] = useState<ToolMode>("gallery");
  const [projects, setProjects] = useState<DrawingProject[]>([]);
  const [currentProject, setCurrentProject] = useState<DrawingProject | null>(null);
  const [settings, setSettings] = useState<AppSettings>(INITIAL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [pendingJoinCode, setPendingJoinCode] = useState("");
  const projectsRef = useRef<DrawingProject[]>([]);

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

  const persistProject = useCallback(async (project: DrawingProject) => {
    setCurrentProject(project);
    const nextProjects = [project, ...projectsRef.current.filter((item) => item.id !== project.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    await saveProjects(nextProjects);
  }, []);

  const updateSettings = useCallback(async (nextSettings: AppSettings) => {
    setSettings(nextSettings);
    await saveStoredSettings(nextSettings);
  }, []);

  const createProject = useCallback(async () => {
    const project = makeProject();
    await persistProject(project);
    setMode("studio");
  }, [persistProject]);

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

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loading}>
          <ActivityIndicator color="#0f766e" />
          <Text style={styles.loadingText}>Opening Happy Paint</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
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
            onBack={() => setMode("gallery")}
            onOpenSettings={() => setMode("settings")}
            onProjectChange={persistProject}
            onSettingsChange={(next) => void updateSettings({ ...settings, ...next })}
            premiumPreview={settings.premiumPreview}
            project={currentProject}
            settings={settings}
          />
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
