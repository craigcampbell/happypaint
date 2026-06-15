import { ArrowLeft, Package, Pencil, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";

import { IconButton } from "./IconButton";
import { deleteSpaceAsset, loadSpaceAssets, renameSpaceAsset } from "../paintSpace";
import type {
  LoopPayload,
  PaintSpaceKind,
  PalettePayload,
  SpaceAsset,
  StickerPayload,
  TemplatePayload
} from "../types";

type Props = {
  onBack: () => void;
  // Apply flows. The host (App) decides how to route each kind.
  onApplySticker: (payload: StickerPayload) => void;
  onApplyPalette: (payload: PalettePayload) => void;
  onApplyTemplate: (asset: SpaceAsset, payload: TemplatePayload) => void;
  onApplyLoop: (asset: SpaceAsset, payload: LoopPayload) => void;
};

const KIND_ORDER: PaintSpaceKind[] = ["sticker", "template", "loop", "palette"];
const KIND_LABEL: Record<PaintSpaceKind, string> = {
  sticker: "Stickers",
  template: "Templates",
  loop: "Loops",
  palette: "Palettes"
};

export function PaintSpaceScreen({ onBack, onApplySticker, onApplyPalette, onApplyTemplate, onApplyLoop }: Props) {
  const [assets, setAssets] = useState<SpaceAsset[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    setAssets(await loadSpaceAssets());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback((asset: SpaceAsset) => {
    Alert.alert("Delete asset?", `${asset.title} will be removed from your locker.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setAssets(await deleteSpaceAsset(asset.id));
        }
      }
    ]);
  }, []);

  const handleUse = useCallback(
    (asset: SpaceAsset) => {
      if (asset.kind === "sticker") {
        onApplySticker(asset.payload as StickerPayload);
      } else if (asset.kind === "palette") {
        onApplyPalette(asset.payload as PalettePayload);
      } else if (asset.kind === "template") {
        onApplyTemplate(asset, asset.payload as TemplatePayload);
      } else {
        onApplyLoop(asset, asset.payload as LoopPayload);
      }
    },
    [onApplyLoop, onApplyPalette, onApplySticker, onApplyTemplate]
  );

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: assets.filter((asset) => asset.kind === kind)
  })).filter((group) => group.items.length > 0);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Paint Space</Text>
          <Text style={styles.subtitle}>Your private locker of stickers, palettes, templates, and loops</Text>
        </View>
      </View>

      {assets.length === 0 ? (
        <View style={styles.emptyState}>
          <Package size={44} color="#64748b" strokeWidth={1.8} />
          <Text style={styles.emptyTitle}>Your locker is empty.</Text>
          <Text style={styles.emptyText}>
            In the studio, use Save to Paint Space to stash a sticker, palette, template, or loop.
          </Text>
        </View>
      ) : (
        grouped.map((group) => (
          <View key={group.kind} style={styles.panel}>
            <Text style={styles.panelTitle}>{KIND_LABEL[group.kind]}</Text>
            <View style={styles.grid}>
              {group.items.map((asset) => (
                <View key={asset.id} style={styles.card}>
                  <View style={styles.preview}>
                    {group.kind === "palette" ? (
                      <View style={styles.paletteRow}>
                        {(asset.payload as PalettePayload).colors.slice(0, 8).map((color, index) => (
                          <View key={`${asset.id}-${index}`} style={[styles.paletteSwatch, { backgroundColor: color }]} />
                        ))}
                      </View>
                    ) : asset.previewUri || asset.thumbnail ? (
                      <Image source={{ uri: asset.previewUri ?? asset.thumbnail }} style={styles.previewImage} />
                    ) : (
                      <Package size={32} color="#94a3b8" />
                    )}
                  </View>
                  <Text numberOfLines={1} style={styles.cardTitle}>
                    {asset.title}
                  </Text>
                  <View style={styles.cardActions}>
                    <Pressable accessibilityRole="button" onPress={() => handleUse(asset)} style={[styles.cardButton, styles.cardButtonPrimary]}>
                      <Text style={styles.cardButtonTextPrimary}>Use</Text>
                    </Pressable>
                    <Pressable accessibilityLabel="Rename" onPress={() => setRenaming({ id: asset.id, value: asset.title })} style={styles.cardIcon}>
                      <Pencil size={16} color="#0f172a" />
                    </Pressable>
                    <Pressable accessibilityLabel="Delete" onPress={() => handleDelete(asset)} style={styles.cardIcon}>
                      <Trash2 size={16} color="#b91c1c" />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))
      )}

      <Modal animationType="fade" transparent visible={!!renaming} onRequestClose={() => setRenaming(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename asset</Text>
            <TextInput
              autoFocus
              onChangeText={(value) => setRenaming((current) => (current ? { ...current, value } : current))}
              style={styles.modalInput}
              value={renaming?.value ?? ""}
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRenaming(null)} style={[styles.modalButton, styles.modalButtonGhost]}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  if (renaming) {
                    setAssets(await renameSpaceAsset(renaming.id, renaming.value.trim() || "Untitled"));
                  }
                  setRenaming(null);
                }}
                style={[styles.modalButton, styles.modalButtonPrimary]}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    overflow: "hidden",
    padding: 8
  },
  cardActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginTop: 8
  },
  cardButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  cardButtonPrimary: {
    backgroundColor: "#0f766e",
    flex: 1
  },
  cardButtonTextPrimary: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center"
  },
  cardIcon: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  cardTitle: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 8
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
    gap: 10
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 16
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.45)",
    flex: 1,
    justifyContent: "center",
    padding: 24
  },
  modalButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  modalButtonGhost: {
    backgroundColor: "#f1f5f9"
  },
  modalButtonPrimary: {
    backgroundColor: "#0f766e"
  },
  modalButtonText: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800"
  },
  modalButtonTextPrimary: {
    color: "#ffffff"
  },
  modalCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 18,
    width: "100%"
  },
  modalInput: {
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  modalTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 12
  },
  paletteRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    padding: 8
  },
  paletteSwatch: {
    borderColor: "#e2e8f0",
    borderRadius: 6,
    borderWidth: 1,
    height: 22,
    width: 22
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12
  },
  panelTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  preview: {
    alignItems: "center",
    aspectRatio: 4 / 3,
    backgroundColor: "#f8fafc",
    borderRadius: 6,
    justifyContent: "center",
    overflow: "hidden"
  },
  previewImage: {
    height: "100%",
    width: "100%"
  },
  screen: {
    gap: 14,
    padding: 16,
    paddingBottom: 28
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  title: {
    color: "#0f172a",
    fontSize: 24,
    fontWeight: "900"
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  }
});
