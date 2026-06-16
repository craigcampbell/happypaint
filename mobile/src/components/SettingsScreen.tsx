import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { ArrowLeft, ChevronRight, Palette, ShieldCheck, Sparkles, Store, Wallet } from "lucide-react-native";

import { IconButton } from "./IconButton";

type Props = {
  calmMode: boolean;
  dropsBalance: number;
  onBack: () => void;
  onToggleCalm: (value: boolean) => void;
  onOpenWallet: () => void;
  onOpenStore: () => void;
  onOpenCreator: () => void;
};

export function SettingsScreen({
  calmMode,
  dropsBalance,
  onBack,
  onToggleCalm,
  onOpenWallet,
  onOpenStore,
  onOpenCreator
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
      </View>

      <Text style={styles.groupLabel}>Drops economy</Text>
      <View style={styles.section}>
        <Pressable accessibilityRole="button" style={styles.navRow} onPress={onOpenWallet}>
          <View style={[styles.rowIcon, styles.dropsIcon]}>
            <Wallet size={22} color="#0369a1" />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Wallet</Text>
            <Text style={styles.rowBody}>{dropsBalance} Drops - balances, activity, and guardian controls.</Text>
          </View>
          <ChevronRight size={22} color="#94a3b8" />
        </Pressable>

        <Pressable accessibilityRole="button" style={styles.navRow} onPress={onOpenStore}>
          <View style={[styles.rowIcon, styles.storeIcon]}>
            <Store size={22} color="#92400e" />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Store</Text>
            <Text style={styles.rowBody}>Get Drops, buy packs, room themes, tokens, and send tips.</Text>
          </View>
          <ChevronRight size={22} color="#94a3b8" />
        </Pressable>

        <Pressable accessibilityRole="button" style={[styles.navRow, styles.navRowLast]} onPress={onOpenCreator}>
          <View style={[styles.rowIcon, styles.creatorIcon]}>
            <Sparkles size={22} color="#5b21b6" />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Creator dashboard</Text>
            <Text style={styles.rowBody}>Your packs, tips, Kudos, moderation, and payout status.</Text>
          </View>
          <ChevronRight size={22} color="#94a3b8" />
        </Pressable>
      </View>

      <View style={styles.economyPanel}>
        <View style={styles.economyHeader}>
          <Palette size={20} color="#0f766e" />
          <Text style={styles.economyTitle}>About Drops</Text>
        </View>
        <Text style={styles.economyText}>
          Drops are a preview currency in this build - no real charges happen. When live, Drops are bought through the
          App Store or Google Play and never expire. On kid accounts, purchasing is behind a parental gate. Kudos are
          earned reputation and can't be cashed out.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  creatorIcon: {
    backgroundColor: "#f5f3ff"
  },
  dropsIcon: {
    backgroundColor: "#f0f9ff"
  },
  economyHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  economyPanel: {
    backgroundColor: "#ecfdf5",
    borderColor: "#a7f3d0",
    borderRadius: 8,
    borderWidth: 1,
    padding: 16
  },
  economyText: {
    color: "#065f46",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8
  },
  economyTitle: {
    color: "#065f46",
    fontSize: 18,
    fontWeight: "900"
  },
  groupLabel: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 8,
    textTransform: "uppercase"
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 20
  },
  navRow: {
    alignItems: "center",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14
  },
  navRowLast: {
    borderBottomWidth: 0
  },
  row: {
    alignItems: "center",
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
  storeIcon: {
    backgroundColor: "#fffbeb"
  },
  title: {
    color: "#0f172a",
    fontSize: 28,
    fontWeight: "900"
  }
});
