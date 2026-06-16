import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ArrowLeft, Award, Heart, Lock, Package, ShieldAlert, Wallet } from "lucide-react-native";

import { dropsToApproxMoney, isMinorAccount, type EconomyState } from "../economy";
import type { SpaceAsset } from "../types";
import { IconButton } from "./IconButton";

type Props = {
  economy: EconomyState;
  paintSpaceAssets: SpaceAsset[];
  onBack: () => void;
  onOpenWallet: () => void;
};

const MOCK_PACKS: Array<{ id: string; title: string; status: "draft" | "pending"; kind: string }> = [
  { id: "mock-pack-1", title: "My Neon Doodles", status: "draft", kind: "Sticker pack" },
  { id: "mock-pack-2", title: "Starter Loops", status: "pending", kind: "Loop pack" }
];

function packStatusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    pending: "In moderation",
    approved: "Live",
    rejected: "Needs changes"
  };
  return map[status] ?? status;
}

export function CreatorDashboardScreen({ economy, paintSpaceAssets, onBack, onOpenWallet }: Props) {
  const wallet = economy.wallet;
  const tips = economy.tipsReceived;
  const tipsTotal = tips.reduce((sum, tip) => sum + tip.amount_drops, 0);
  const minor = isMinorAccount(economy);

  // Prefer the user's real Paint Space assets as "my packs"; fall back to a mock
  // so the surface is never empty.
  const myAssets = paintSpaceAssets.slice(0, 6);
  const pendingPacks = MOCK_PACKS.filter((pack) => pack.status === "pending");

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <Text style={styles.title}>Creator</Text>
      </View>

      <View style={styles.stats}>
        <View style={styles.statCard}>
          <Heart size={16} color="#be123c" />
          <Text style={styles.statLabel}>Tips received</Text>
          <Text style={styles.statValue}>{tipsTotal} Drops</Text>
          <Text style={styles.statMeta}>~ {dropsToApproxMoney(tipsTotal)}</Text>
        </View>
        <View style={styles.statCard}>
          <Lock size={16} color="#5b21b6" />
          <Text style={styles.statLabel}>Locked balance</Text>
          <Text style={styles.statValue}>{wallet.locked_balance} Drops</Text>
          <Text style={styles.statMeta}>Not withdrawable yet</Text>
        </View>
        <View style={styles.statCard}>
          <Award size={16} color="#92400e" />
          <Text style={styles.statLabel}>Kudos earned</Text>
          <Text style={styles.statValue}>{wallet.kudos_balance}</Text>
          <Text style={styles.statMeta}>Reputation</Text>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Package size={18} color="#0f172a" />
          <Text style={styles.sectionTitle}>My packs</Text>
        </View>
        {myAssets.length > 0
          ? myAssets.map((asset) => (
              <View key={asset.id} style={styles.listRow}>
                <Text style={styles.listTitle} numberOfLines={1}>
                  {asset.title}
                </Text>
                <Text style={styles.listMeta}>{asset.kind}</Text>
              </View>
            ))
          : MOCK_PACKS.map((pack) => (
              <View key={pack.id} style={styles.listRow}>
                <Text style={styles.listTitle} numberOfLines={1}>
                  {pack.title}
                </Text>
                <Text style={styles.listMeta}>
                  {pack.kind} - {packStatusLabel(pack.status)}
                </Text>
              </View>
            ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Heart size={18} color="#be123c" />
          <Text style={styles.sectionTitle}>Tips received</Text>
        </View>
        {tips.length === 0 ? (
          <Text style={styles.emptyText}>No tips yet. Share art to earn tips into your locked balance.</Text>
        ) : (
          tips.slice(0, 8).map((tip) => (
            <View key={tip.id} style={styles.listRow}>
              <Text style={styles.listTitleCredit}>+{tip.amount_drops} Drops</Text>
              <Text style={styles.listMeta}>
                {tip.source_type.replace(/_/g, " ")} - {new Date(tip.created_at).toLocaleDateString()}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <ShieldAlert size={18} color="#92400e" />
          <Text style={styles.sectionTitle}>Pending moderation</Text>
        </View>
        {pendingPacks.length === 0 ? (
          <Text style={styles.emptyText}>Nothing waiting on moderation.</Text>
        ) : (
          pendingPacks.map((pack) => (
            <View key={pack.id} style={styles.listRow}>
              <Text style={styles.listTitle}>{pack.title}</Text>
              <Text style={styles.listMeta}>In moderation</Text>
            </View>
          ))
        )}
      </View>

      <View style={[styles.section, styles.payoutSection]}>
        <View style={styles.sectionHead}>
          <Lock size={18} color="#5b21b6" />
          <Text style={styles.sectionTitle}>Payout status</Text>
        </View>
        <Text style={styles.payoutText}>
          Payouts not available yet. Tips accumulate into a locked creator balance you can spend inside Happy Paint.
          {minor
            ? " Cash-out for teen creators will require guardian approval, identity checks, and tax info before it opens."
            : " Cash-out opens in a later phase once safety, tax, and payout controls are ready."}
        </Text>
        <View style={[styles.lockedButton]}>
          <Lock size={16} color="#6b7280" />
          <Text style={styles.lockedButtonText}>Set up payouts (locked)</Text>
        </View>
      </View>

      <IconButton icon={Wallet} label="View wallet" onPress={onOpenWallet} tone="dark" style={styles.walletButton} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  emptyText: {
    color: "#64748b",
    fontSize: 14,
    paddingVertical: 8
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 20
  },
  listMeta: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "700"
  },
  listRow: {
    alignItems: "center",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    paddingVertical: 12
  },
  listTitle: {
    color: "#0f172a",
    flex: 1,
    fontSize: 15,
    fontWeight: "800"
  },
  listTitleCredit: {
    color: "#047857",
    fontSize: 15,
    fontWeight: "900"
  },
  lockedButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#f3f4f6",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    minHeight: 42,
    paddingHorizontal: 14
  },
  lockedButtonText: {
    color: "#6b7280",
    fontSize: 14,
    fontWeight: "900"
  },
  payoutSection: {
    backgroundColor: "#f5f3ff",
    borderColor: "#ddd6fe"
  },
  payoutText: {
    color: "#4c1d95",
    fontSize: 13,
    lineHeight: 19
  },
  screen: {
    flexGrow: 1,
    padding: 16
  },
  section: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 16,
    padding: 14
  },
  sectionHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 6
  },
  sectionTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  statCard: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "30%",
    flexGrow: 1,
    gap: 3,
    padding: 12
  },
  statLabel: {
    color: "#334155",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 2
  },
  statMeta: {
    color: "#64748b",
    fontSize: 11
  },
  statValue: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16
  },
  title: {
    color: "#0f172a",
    fontSize: 28,
    fontWeight: "900"
  },
  walletButton: {
    alignSelf: "flex-start"
  }
});
