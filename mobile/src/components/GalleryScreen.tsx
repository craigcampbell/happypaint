import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { CopyPlus, ImagePlus, Palette, Search, Settings, Trash2, Users } from "lucide-react-native";

import { IconButton } from "./IconButton";
import type { DrawingProject } from "../types";

type Props = {
  projects: DrawingProject[];
  onCreate: () => void;
  onOpen: (project: DrawingProject) => void;
  onDelete: (project: DrawingProject) => void;
  onDiscover: () => void;
  onSettings: () => void;
  onTogether: () => void;
};

export function GalleryScreen({ projects, onCreate, onOpen, onDelete, onDiscover, onSettings, onTogether }: Props) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Happy Paint</Text>
          <Text style={styles.subtitle}>Your art shelf and room browser</Text>
        </View>
        <IconButton icon={Settings} label="Settings" onPress={onSettings} />
      </View>

      <View style={styles.actions}>
        <IconButton icon={Palette} label="New painting" onPress={onCreate} tone="dark" />
        <IconButton icon={Search} label="Discover" onPress={onDiscover} />
        <IconButton icon={Users} label="Paint together" onPress={onTogether} />
      </View>

      {projects.length === 0 ? (
        <View style={styles.emptyState}>
          <ImagePlus size={44} color="#64748b" strokeWidth={1.8} />
          <Text style={styles.emptyTitle}>A fresh page is waiting.</Text>
          <Text style={styles.emptyText}>Start a painting and it will autosave here for next time.</Text>
          <IconButton icon={CopyPlus} label="Make first painting" onPress={onCreate} tone="dark" />
        </View>
      ) : (
        <View style={styles.grid}>
          {projects.map((project) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${project.title}`}
              key={project.id}
              onPress={() => onOpen(project)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            >
              <View style={styles.preview}>
                {project.previewUri ? (
                  <Image source={{ uri: project.previewUri }} style={styles.previewImage} />
                ) : (
                  <Palette size={48} color="#94a3b8" />
                )}
              </View>
              <View style={styles.cardFooter}>
                <View style={styles.cardText}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {project.title}
                  </Text>
                  <Text style={styles.cardMeta}>{new Date(project.updatedAt).toLocaleDateString()}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${project.title}`}
                  hitSlop={12}
                  onPress={() => onDelete(project)}
                  style={styles.deleteButton}
                >
                  <Trash2 size={18} color="#b91c1c" />
                </Pressable>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16
  },
  card: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    overflow: "hidden"
  },
  cardFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    padding: 10
  },
  cardMeta: {
    color: "#64748b",
    fontSize: 12
  },
  cardPressed: {
    opacity: 0.82
  },
  cardText: {
    flex: 1
  },
  cardTitle: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "800"
  },
  deleteButton: {
    alignItems: "center",
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  emptyState: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 24
  },
  emptyText: {
    color: "#64748b",
    fontSize: 15,
    lineHeight: 21,
    maxWidth: 280,
    textAlign: "center"
  },
  emptyTitle: {
    color: "#0f172a",
    fontSize: 20,
    fontWeight: "900"
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16
  },
  preview: {
    alignItems: "center",
    aspectRatio: 4 / 3,
    backgroundColor: "#f8fafc",
    justifyContent: "center"
  },
  previewImage: {
    height: "100%",
    width: "100%"
  },
  screen: {
    flex: 1,
    padding: 16
  },
  subtitle: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: "600"
  },
  title: {
    color: "#0f172a",
    fontSize: 30,
    fontWeight: "900"
  }
});
