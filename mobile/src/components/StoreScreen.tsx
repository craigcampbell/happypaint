import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ArrowLeft, Check, Gift, Heart, Info, Sparkles } from "lucide-react-native";

import {
  dropsToApproxMoney,
  formatPrice,
  STORE_CATEGORIES,
  STORE_ITEMS,
  TIP_PRESETS,
  type DropProduct,
  type EconomyState,
  type StoreItem
} from "../economy";
import { DROP_PRODUCTS } from "../economy";
import { IconButton } from "./IconButton";

type Props = {
  economy: EconomyState;
  onBack: () => void;
  onBuyDrops: (product: DropProduct) => void;
  onBuyItem: (item: StoreItem) => void;
  onSendTip: (amount: number) => void;
};

export function StoreScreen({ economy, onBack, onBuyDrops, onBuyItem, onSendTip }: Props) {
  const [tipAmount, setTipAmount] = useState<number>(TIP_PRESETS[0]);
  const balance = economy.wallet.drops_balance;

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <View style={styles.headerText}>
          <Text style={styles.title}>Store</Text>
          <Text style={styles.subtitle}>{balance} Drops ~ {dropsToApproxMoney(balance)}</Text>
        </View>
      </View>

      <View style={[styles.note, styles.previewNote]}>
        <Info size={18} color="#92400e" />
        <Text style={styles.previewNoteText}>
          Preview build: no real charges happen here. When live, buying Drops uses Apple App Store or Google Play
          in-app purchase. On kid accounts, purchasing is behind a parental gate. Purchased Drops never expire. No
          loot boxes - every pack is a transparent bundle.
        </Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Sparkles size={20} color="#0369a1" />
          <Text style={styles.sectionTitle}>Get Drops</Text>
        </View>
        <View style={styles.grid}>
          {DROP_PRODUCTS.filter((product) => product.active).map((product) => (
            <View key={product.id} style={styles.dropCard}>
              <Text style={styles.dropAmount}>{product.drop_amount}</Text>
              <Text style={styles.dropLabel}>Drops</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Buy ${product.drop_amount} Drops for ${formatPrice(product.price_cents)}`}
                onPress={() => onBuyDrops(product)}
                style={({ pressed }) => [styles.buyButton, styles.dropBuy, pressed && styles.pressed]}
              >
                <Text style={styles.dropBuyText}>{formatPrice(product.price_cents)}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </View>

      {STORE_CATEGORIES.map((category) => {
        const items = STORE_ITEMS.filter((item) => item.category === category.id);
        if (items.length === 0) {
          return null;
        }
        return (
          <View key={category.id} style={styles.section}>
            <View style={styles.sectionHead}>
              <Gift size={20} color="#0f172a" />
              <Text style={styles.sectionTitle}>{category.label}</Text>
            </View>
            {items.map((item) => {
              const owned = economy.owned.includes(item.id);
              const affordable = balance >= item.price_drops;
              return (
                <View key={item.id} style={styles.itemCard}>
                  <View style={styles.itemText}>
                    <Text style={styles.itemTitle}>{item.title}</Text>
                    <Text style={styles.itemDesc}>{item.description}</Text>
                    <Text style={styles.itemPrice}>
                      {item.price_drops} Drops ~ {dropsToApproxMoney(item.price_drops)}
                    </Text>
                  </View>
                  {owned ? (
                    <View style={[styles.buyButton, styles.ownedButton]}>
                      <Check size={16} color="#047857" />
                      <Text style={styles.ownedText}>Owned</Text>
                    </View>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Buy ${item.title}`}
                      disabled={!affordable}
                      onPress={() => onBuyItem(item)}
                      style={({ pressed }) => [
                        styles.buyButton,
                        styles.itemBuy,
                        !affordable && styles.disabled,
                        pressed && affordable && styles.pressed
                      ]}
                    >
                      <Text style={styles.itemBuyText}>{affordable ? "Buy" : "Need Drops"}</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        );
      })}

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Heart size={20} color="#be123c" />
          <Text style={styles.sectionTitle}>Send a tip</Text>
        </View>
        <Text style={styles.tipHelp}>
          Tip a creator with Drops. Fixed amounts only - no free-form messages on kid-safe surfaces. Tips go into a
          locked creator balance.
        </Text>
        <View style={styles.tipRow}>
          {TIP_PRESETS.map((amount) => (
            <Pressable
              key={amount}
              accessibilityRole="button"
              accessibilityState={{ selected: tipAmount === amount }}
              onPress={() => setTipAmount(amount)}
              style={[styles.tipChip, tipAmount === amount && styles.tipChipActive]}
            >
              <Text style={[styles.tipChipText, tipAmount === amount && styles.tipChipTextActive]}>{amount}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send a ${tipAmount} Drops tip`}
          disabled={balance < tipAmount}
          onPress={() => onSendTip(tipAmount)}
          style={({ pressed }) => [
            styles.buyButton,
            styles.tipButton,
            balance < tipAmount && styles.disabled,
            pressed && balance >= tipAmount && styles.pressed
          ]}
        >
          <Text style={styles.tipButtonText}>
            {balance < tipAmount ? "Need more Drops" : `Send ${tipAmount} Drops tip`}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  buyButton: {
    alignItems: "center",
    borderRadius: 8,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 14
  },
  disabled: {
    opacity: 0.45
  },
  dropAmount: {
    color: "#0f172a",
    fontSize: 24,
    fontWeight: "900"
  },
  dropBuy: {
    backgroundColor: "#0369a1",
    marginTop: 8
  },
  dropBuyText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900"
  },
  dropCard: {
    alignItems: "center",
    backgroundColor: "#f0f9ff",
    borderColor: "#bae6fd",
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: "48%",
    flexGrow: 1,
    padding: 14
  },
  dropLabel: {
    color: "#0369a1",
    fontSize: 13,
    fontWeight: "800"
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 16
  },
  headerText: {
    flex: 1
  },
  itemBuy: {
    backgroundColor: "#111827"
  },
  itemBuyText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "900"
  },
  itemCard: {
    alignItems: "center",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14
  },
  itemDesc: {
    color: "#64748b",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2
  },
  itemPrice: {
    color: "#92400e",
    fontSize: 13,
    fontWeight: "800",
    marginTop: 6
  },
  itemText: {
    flex: 1
  },
  itemTitle: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "900"
  },
  note: {
    alignItems: "flex-start",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 14
  },
  ownedButton: {
    backgroundColor: "#ecfdf5",
    borderColor: "#a7f3d0",
    borderWidth: 1
  },
  ownedText: {
    color: "#047857",
    fontSize: 14,
    fontWeight: "900"
  },
  pressed: {
    transform: [{ scale: 0.98 }]
  },
  previewNote: {
    backgroundColor: "#fffbeb",
    borderColor: "#fcd34d",
    marginBottom: 16
  },
  previewNoteText: {
    color: "#78350f",
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
    marginBottom: 16,
    padding: 14
  },
  sectionHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 12
  },
  sectionTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  subtitle: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 2
  },
  tipButton: {
    backgroundColor: "#be123c",
    marginTop: 12
  },
  tipButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900"
  },
  tipChip: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    minHeight: 44,
    justifyContent: "center"
  },
  tipChipActive: {
    backgroundColor: "#be123c",
    borderColor: "#be123c"
  },
  tipChipText: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "900"
  },
  tipChipTextActive: {
    color: "#ffffff"
  },
  tipHelp: {
    color: "#64748b",
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12
  },
  tipRow: {
    flexDirection: "row",
    gap: 8
  },
  title: {
    color: "#0f172a",
    fontSize: 28,
    fontWeight: "900"
  }
});
