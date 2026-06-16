// Publish a Community Brush Pack from the locker.
//
// Lets the user name a pack, pick which of their saved brush/sticker/palette/
// template assets go in it, choose visibility (private / friends / public —
// public requires review) and a remix permission, then "Submit for review".
// The host (PaintSpaceScreen) owns persistence via onPublish, which calls
// brushPacks.publishPack (writes the asset_packs row + asset_moderation_queue
// entry).

import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Check } from "lucide-react-native";

import {
  PACK_VISIBILITY_OPTIONS,
  REMIX_PERMISSIONS,
  type PackPublishVisibility
} from "../brushPacks";
import type { PaintSpaceKind, RemixPermission, SpaceAsset } from "../types";

// Asset kinds eligible to be packed (per docs: brushes + sticker/palette/
// template). Loops/timelapses are excluded for the brush-pack MVP.
const PACKABLE_KINDS: PaintSpaceKind[] = ["brush", "sticker", "palette", "template"];

type Props = {
  visible: boolean;
  assets: SpaceAsset[];
  onClose: () => void;
  onPublish: (input: {
    title: string;
    assets: SpaceAsset[];
    visibility: PackPublishVisibility;
    remix_permission: RemixPermission;
  }) => void;
};

export function PublishPackModal({ visible, assets, onClose, onPublish }: Props) {
  const packable = useMemo(() => assets.filter((asset) => PACKABLE_KINDS.includes(asset.kind)), [assets]);
  const [title, setTitle] = useState("My Brush Pack");
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    packable.filter((asset) => asset.kind === "brush").map((asset) => asset.id)
  );
  const [visibility, setVisibility] = useState<PackPublishVisibility>("public");
  const [remix, setRemix] = useState<RemixPermission>("none");

  const toggle = (id: string) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const selectedAssets = packable.filter((asset) => selectedIds.includes(asset.id));
  const needsReview = visibility === "public" || visibility === "friends";
  const visibilityNote = PACK_VISIBILITY_OPTIONS.find((opt) => opt.id === visibility)?.note ?? "";

  const submit = () => {
    if (selectedAssets.length === 0) {
      return;
    }
    onPublish({
      title: title.trim() || "My Brush Pack",
      assets: selectedAssets,
      visibility,
      remix_permission: remix
    });
  };

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>Publish a Brush Pack</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Group your saved assets into a pack and submit it. Public packs are reviewed before they go live.
          </Text>

          {packable.length === 0 ? (
            <Text style={styles.empty}>Save some brushes in Brush Studio first, then come back to publish a pack.</Text>
          ) : (
            <ScrollView contentContainerStyle={styles.body}>
              <Text style={styles.label}>Pack name</Text>
              <TextInput onChangeText={setTitle} placeholder="Pack name" style={styles.input} value={title} />

              <Text style={styles.label}>Choose assets ({selectedAssets.length} selected)</Text>
              <View style={styles.list}>
                {packable.map((asset) => {
                  const selected = selectedIds.includes(asset.id);
                  return (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      key={asset.id}
                      onPress={() => toggle(asset.id)}
                      style={styles.listItem}
                    >
                      <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                        {selected ? <Check size={14} color="#ffffff" strokeWidth={3} /> : null}
                      </View>
                      <Text numberOfLines={1} style={styles.itemTitle}>
                        {asset.title}
                      </Text>
                      <Text style={styles.itemKind}>{asset.kind}</Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.label}>Visibility</Text>
              <View style={styles.segmentRow}>
                {PACK_VISIBILITY_OPTIONS.map((opt) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: visibility === opt.id }}
                    key={opt.id}
                    onPress={() => setVisibility(opt.id)}
                    style={[styles.segment, visibility === opt.id && styles.segmentOn]}
                  >
                    <Text style={[styles.segmentText, visibility === opt.id && styles.segmentTextOn]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.note}>{visibilityNote}</Text>

              <Text style={styles.label}>Remix permission</Text>
              <View style={styles.segmentRow}>
                {REMIX_PERMISSIONS.map((opt) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: remix === opt.id }}
                    key={opt.id}
                    onPress={() => setRemix(opt.id)}
                    style={[styles.segment, remix === opt.id && styles.segmentOn]}
                  >
                    <Text style={[styles.segmentText, remix === opt.id && styles.segmentTextOn]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>

              {needsReview ? (
                <Text style={styles.compliance}>
                  Community packs require moderation before they appear in browse or featured.
                </Text>
              ) : null}

              <View style={styles.actions}>
                <Pressable onPress={onClose} style={[styles.actionButton, styles.actionGhost]}>
                  <Text style={styles.actionText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityState={{ disabled: selectedAssets.length === 0 }}
                  disabled={selectedAssets.length === 0}
                  onPress={submit}
                  style={[styles.actionButton, styles.actionPrimary, selectedAssets.length === 0 && styles.actionDisabled]}
                >
                  <Text style={[styles.actionText, styles.actionTextPrimary]}>
                    {needsReview ? "Submit for review" : "Save pack"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    borderRadius: 8,
    flex: 1,
    paddingVertical: 12
  },
  actionDisabled: {
    opacity: 0.45
  },
  actionGhost: {
    backgroundColor: "#f1f5f9"
  },
  actionPrimary: {
    backgroundColor: "#0f766e"
  },
  actionText: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center"
  },
  actionTextPrimary: {
    color: "#ffffff"
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8
  },
  backdrop: {
    backgroundColor: "rgba(15,23,42,0.45)",
    flex: 1,
    justifyContent: "flex-end"
  },
  body: {
    gap: 8,
    paddingBottom: 12
  },
  card: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    gap: 10,
    maxHeight: "88%",
    padding: 18
  },
  checkbox: {
    alignItems: "center",
    borderColor: "#94a3b8",
    borderRadius: 6,
    borderWidth: 2,
    height: 22,
    justifyContent: "center",
    width: 22
  },
  checkboxOn: {
    backgroundColor: "#0f766e",
    borderColor: "#0f766e"
  },
  closeButton: {
    backgroundColor: "#f1f5f9",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  closeText: {
    color: "#0f172a",
    fontSize: 13,
    fontWeight: "900"
  },
  compliance: {
    backgroundColor: "#ecfdf5",
    borderColor: "#99f6e4",
    borderRadius: 8,
    borderWidth: 1,
    color: "#0f766e",
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 17,
    padding: 10
  },
  empty: {
    color: "#64748b",
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 16,
    textAlign: "center"
  },
  input: {
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  itemKind: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase"
  },
  itemTitle: {
    color: "#0f172a",
    flex: 1,
    fontSize: 14,
    fontWeight: "800"
  },
  label: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "900",
    marginTop: 6
  },
  list: {
    gap: 6
  },
  listItem: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 10
  },
  note: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17
  },
  segment: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    minWidth: 90,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  segmentOn: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  segmentText: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "800"
  },
  segmentTextOn: {
    color: "#134e4a"
  },
  subtitle: {
    color: "#64748b",
    fontSize: 13,
    lineHeight: 18
  },
  title: {
    color: "#0f172a",
    flex: 1,
    fontSize: 19,
    fontWeight: "900"
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  }
});
