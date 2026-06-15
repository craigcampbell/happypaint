import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { ArrowLeft, Crown, Download, ShieldCheck } from "lucide-react-native";

import { STUDIO_PACKS } from "../constants";
import { IconButton } from "./IconButton";

type Props = {
  calmMode: boolean;
  premiumPreview: boolean;
  onBack: () => void;
  onToggleCalm: (value: boolean) => void;
  onTogglePremiumPreview: (value: boolean) => void;
};

export function SettingsScreen({
  calmMode,
  premiumPreview,
  onBack,
  onToggleCalm,
  onTogglePremiumPreview
}: Props) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Gallery" onPress={onBack} />
        <Text style={styles.title}>Settings</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.row}>
          <View style={styles.rowIcon}>
            <ShieldCheck size={24} color="#0f766e" />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Calm controls</Text>
            <Text style={styles.rowBody}>Larger buttons, fewer distractions, and gentle colors for younger artists.</Text>
          </View>
          <Switch value={calmMode} onValueChange={onToggleCalm} />
        </View>

        <View style={styles.row}>
          <View style={styles.rowIcon}>
            <Crown size={24} color="#92400e" />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Drops preview</Text>
            <Text style={styles.rowBody}>Try locked brushes and papers while the future Drops wallet stays out of the way.</Text>
          </View>
          <Switch value={premiumPreview} onValueChange={onTogglePremiumPreview} />
        </View>
      </View>

      <Pressable style={styles.premiumPanel} accessibilityRole="button">
        <View style={styles.premiumHeader}>
          <Crown size={22} color="#92400e" />
          <Text style={styles.premiumTitle}>Drops Packs</Text>
        </View>
        <Text style={styles.premiumText}>
          Built for future Drops purchases, creator tips, community packs, room themes, and export upgrades.
        </Text>
        <View style={styles.packGrid}>
          {STUDIO_PACKS.map((pack) => (
            <View key={pack.id} style={styles.packCard}>
              <Text style={styles.packTitle}>{pack.title}</Text>
              <Text style={styles.packPrice}>{pack.price}</Text>
              <Text style={styles.packPerks}>{pack.perks.join(" • ")}</Text>
            </View>
          ))}
        </View>
        <View style={styles.disabledButton}>
          <Download size={17} color="#6b7280" />
          <Text style={styles.disabledButtonText}>Wallet flow placeholder</Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  disabledButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#f3f4f6",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
    minHeight: 40,
    paddingHorizontal: 12
  },
  disabledButtonText: {
    color: "#6b7280",
    fontSize: 14,
    fontWeight: "800"
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 20
  },
  premiumHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  premiumPanel: {
    backgroundColor: "#fffbeb",
    borderColor: "#f59e0b",
    borderRadius: 8,
    borderWidth: 1,
    padding: 16
  },
  premiumText: {
    color: "#78350f",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8
  },
  premiumTitle: {
    color: "#78350f",
    fontSize: 18,
    fontWeight: "900"
  },
  packCard: {
    backgroundColor: "#ffffff",
    borderColor: "#fcd34d",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    gap: 4,
    padding: 10
  },
  packGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 14
  },
  packPerks: {
    color: "#78350f",
    fontSize: 12,
    lineHeight: 17
  },
  packPrice: {
    color: "#92400e",
    fontSize: 14,
    fontWeight: "900"
  },
  packTitle: {
    color: "#78350f",
    fontSize: 15,
    fontWeight: "900"
  },
  row: {
    alignItems: "center",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14
  },
  rowBody: {
    color: "#64748b",
    fontSize: 14,
    lineHeight: 20
  },
  rowIcon: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 8,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  rowText: {
    flex: 1
  },
  rowTitle: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 2
  },
  screen: {
    flex: 1,
    padding: 16
  },
  section: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 16,
    paddingHorizontal: 14
  },
  title: {
    color: "#0f172a",
    fontSize: 28,
    fontWeight: "900"
  }
});
