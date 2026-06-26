import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ArrowLeft, Award, Lock, ShieldCheck, ShoppingBag, Sparkles } from "lucide-react-native";

import {
  describeLedgerSource,
  dropsToApproxMoney,
  isMinorAccount,
  type EconomyState,
  type WalletLedgerEntry
} from "../economy";
import { IconButton } from "./IconButton";

type Props = {
  economy: EconomyState;
  onBack: () => void;
  onOpenStore: () => void;
};

function currencyLabel(type: WalletLedgerEntry["currency_type"]): string {
  if (type === "kudos") {
    return "Kudos";
  }
  if (type === "creator") {
    return "Creator";
  }
  return "Drops";
}

function ActivityRow({ entry }: { entry: WalletLedgerEntry }) {
  const credit = entry.direction === "credit";
  return (
    <View style={styles.activityRow}>
      <View style={styles.activityText}>
        <Text style={styles.activityLabel}>{describeLedgerSource(entry)}</Text>
        <Text style={styles.activityTime}>{new Date(entry.created_at).toLocaleString()}</Text>
      </View>
      <Text style={[styles.activityAmount, credit ? styles.credit : styles.debit]}>
        {credit ? "+" : "-"}
        {entry.amount} {currencyLabel(entry.currency_type)}
      </Text>
    </View>
  );
}

export function WalletScreen({ economy, onBack, onOpenStore }: Props) {
  const wallet = economy.wallet;
  const recent = economy.ledger.slice(0, 12);
  const minor = isMinorAccount(economy);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <Text style={styles.title}>Wallet</Text>
      </View>

      <View style={styles.balances}>
        <View style={[styles.balanceCard, styles.dropsCard]}>
          <View style={styles.balanceHead}>
            <Sparkles size={18} color="#0369a1" />
            <Text style={styles.balanceLabel}>Drops</Text>
          </View>
          <Text style={styles.balanceValue}>{wallet.drops_balance}</Text>
          <Text style={styles.balanceMeta}>~ {dropsToApproxMoney(wallet.drops_balance)}</Text>
        </View>
        <View style={[styles.balanceCard, styles.kudosCard]}>
          <View style={styles.balanceHead}>
            <Award size={18} color="#92400e" />
            <Text style={styles.balanceLabel}>Kudos</Text>
          </View>
          <Text style={styles.balanceValue}>{wallet.kudos_balance}</Text>
          <Text style={styles.balanceMeta}>Earned reputation</Text>
        </View>
        <View style={[styles.balanceCard, styles.lockedCard]}>
          <View style={styles.balanceHead}>
            <Lock size={18} color="#5b21b6" />
            <Text style={styles.balanceLabel}>Creator (locked)</Text>
          </View>
          <Text style={styles.balanceValue}>{wallet.locked_balance}</Text>
          <Text style={styles.balanceMeta}>From tips</Text>
        </View>
      </View>

      <IconButton icon={ShoppingBag} label="Get Drops & Shop" onPress={onOpenStore} tone="dark" style={styles.shopButton} />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent activity</Text>
        {recent.length === 0 ? (
          <Text style={styles.emptyText}>No wallet activity yet.</Text>
        ) : (
          <View>
            {recent.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </View>
        )}
      </View>

      <View style={styles.note}>
        <ShieldCheck size={18} color="#0f766e" />
        <Text style={styles.noteText}>
          {minor
            ? "Guardian controls apply to this account. Spending is guardian-controllable and a guardian can view full purchase history. Drops are bought through the App Store or Google Play and never expire."
            : "Purchased Drops never expire. Kudos are earned reputation and can't be cashed out. This preview makes no real charges."}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  activityAmount: {
    fontSize: 15,
    fontWeight: "900"
  },
  activityLabel: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "800"
  },
  activityRow: {
    alignItems: "center",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    paddingVertical: 12
  },
  activityText: {
    flex: 1
  },
  activityTime: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2
  },
  balanceCard: {
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    gap: 4,
    padding: 14
  },
  balanceHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6
  },
  balanceLabel: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "800"
  },
  balanceMeta: {
    color: "#64748b",
    fontSize: 12
  },
  balanceValue: {
    color: "#0f172a",
    fontSize: 26,
    fontWeight: "900"
  },
  balances: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16
  },
  credit: {
    color: "#047857"
  },
  debit: {
    color: "#b91c1c"
  },
  dropsCard: {
    backgroundColor: "#f0f9ff",
    borderColor: "#bae6fd"
  },
  emptyText: {
    color: "#64748b",
    fontSize: 14,
    paddingVertical: 12
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 20
  },
  kudosCard: {
    backgroundColor: "#fffbeb",
    borderColor: "#fde68a"
  },
  lockedCard: {
    backgroundColor: "#f5f3ff",
    borderColor: "#ddd6fe"
  },
  note: {
    alignItems: "flex-start",
    backgroundColor: "#ecfdf5",
    borderColor: "#a7f3d0",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
    padding: 14
  },
  noteText: {
    color: "#065f46",
    flex: 1,
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
    paddingHorizontal: 14,
    paddingVertical: 6
  },
  sectionTitle: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "900",
    paddingTop: 10
  },
  shopButton: {
    alignSelf: "flex-start",
    marginBottom: 16
  },
  title: {
    color: "#0f172a",
    fontSize: 28,
    fontWeight: "900"
  }
});
