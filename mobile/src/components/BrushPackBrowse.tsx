import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Brush, Download, ShieldCheck } from "lucide-react-native";

import { getBrowsablePacks, getPackAssets, remixLabel, type AssetPack } from "../brushPacks";

type Props = {
  // Filter packs to the discovery search (matches title/tags).
  matches: (item: { title?: string; tags?: string[] }) => boolean;
};

function PackCard({ pack, onGet }: { pack: AssetPack; onGet: (pack: AssetPack) => void }) {
  const brushCount = pack.items.filter((item) => item.asset.kind === "brush").length;
  return (
    <View style={styles.packCard}>
      <View style={styles.previewRow}>
        {pack.items.slice(0, 4).map((item) => {
          const palette = item.asset.brush_recipe?.glow ? [pack.accent, "#ffffff"] : [pack.accent];
          return (
            <View key={item.asset_id} style={[styles.previewChip, { backgroundColor: palette[0] }]}>
              <Brush size={16} color="#ffffff" strokeWidth={2.4} />
            </View>
          );
        })}
      </View>
      <Text style={styles.packTitle} numberOfLines={1}>
        {pack.title}
      </Text>
      <Text style={styles.packAuthor}>by {pack.authorSpace}</Text>
      {pack.description ? (
        <Text style={styles.packDesc} numberOfLines={2}>
          {pack.description}
        </Text>
      ) : null}
      <View style={styles.tagWrap}>
        {pack.tags.slice(0, 4).map((tag) => (
          <Text key={tag} style={styles.miniTag}>
            {tag}
          </Text>
        ))}
      </View>
      <Text style={styles.remix}>{remixLabel(pack.remix_permission)}</Text>
      <View style={styles.cardFooter}>
        <Text style={styles.brushCount}>{brushCount} brushes</Text>
        <Pressable accessibilityRole="button" onPress={() => onGet(pack)} style={styles.getButton}>
          <Download size={15} color="#ffffff" strokeWidth={2.4} />
          <Text style={styles.getButtonText}>Get</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function BrushPackBrowse({ matches }: Props) {
  const [packs, setPacks] = useState<AssetPack[]>([]);

  useEffect(() => {
    let active = true;
    void getBrowsablePacks().then((list) => {
      if (active) {
        setPacks(list);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const visiblePacks = useMemo(() => packs.filter((pack) => matches(pack)), [matches, packs]);

  const handleGet = useCallback(async (pack: AssetPack) => {
    const result = await getPackAssets(pack);
    if (result.added > 0) {
      Alert.alert(
        "Added to your brushes",
        `${result.added} ${result.added === 1 ? "brush" : "brushes"} from "${pack.title}" copied into your locker. Open Brush Studio to use them.`
      );
    } else {
      Alert.alert("Nothing to add", "This pack has no brushes to copy yet.");
    }
  }, []);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Brush size={20} color="#0f172a" strokeWidth={2.4} />
        <Text style={styles.sectionTitle}>Community Brush Packs</Text>
        <Text style={styles.count}>{visiblePacks.length}</Text>
      </View>

      <View style={styles.complianceRow}>
        <ShieldCheck size={15} color="#0f766e" strokeWidth={2.4} />
        <Text style={styles.complianceText}>
          Packs are reviewed before going public or featured. Browse by pack and topic — there is no people search.
        </Text>
      </View>

      <View style={styles.grid}>
        {visiblePacks.map((pack) => (
          <PackCard key={pack.id} onGet={handleGet} pack={pack} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  brushCount: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "800"
  },
  cardFooter: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4
  },
  complianceRow: {
    alignItems: "flex-start",
    backgroundColor: "#ecfdf5",
    borderColor: "#99f6e4",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 10
  },
  complianceText: {
    color: "#0f766e",
    flex: 1,
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 17
  },
  count: {
    backgroundColor: "#e0f2fe",
    borderRadius: 999,
    color: "#075985",
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  getButton: {
    alignItems: "center",
    backgroundColor: "#0f766e",
    borderRadius: 8,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  getButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "900"
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12
  },
  miniTag: {
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 999,
    borderWidth: 1,
    color: "#334155",
    fontSize: 11,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  packAuthor: {
    color: "#0f766e",
    fontSize: 12,
    fontWeight: "900"
  },
  packCard: {
    backgroundColor: "#fbfdfd",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    gap: 6,
    padding: 10
  },
  packDesc: {
    color: "#475569",
    fontSize: 13,
    lineHeight: 18
  },
  packTitle: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "900"
  },
  previewChip: {
    alignItems: "center",
    borderRadius: 8,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  previewRow: {
    flexDirection: "row",
    gap: 6
  },
  remix: {
    color: "#92400e",
    fontSize: 12,
    fontWeight: "900"
  },
  section: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  sectionTitle: {
    color: "#0f172a",
    flex: 1,
    fontSize: 18,
    fontWeight: "900"
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6
  }
});
