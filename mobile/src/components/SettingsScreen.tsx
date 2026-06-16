import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  ArrowLeft,
  ChevronRight,
  CloudOff,
  LogOut,
  Palette,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
  UserCircle,
  Wallet
} from "lucide-react-native";

import { IconButton } from "./IconButton";
import {
  getSession,
  isCloudConfigured,
  LOCAL_ONLY_MESSAGE,
  OAUTH_PROVIDERS,
  sessionLabel,
  signInWithEmail,
  signInWithProvider,
  signOut,
  type AuthSession,
  type OAuthProviderId
} from "../auth";
import {
  AI_POLICY_VERSION,
  isAiConsented,
  loadAiConsent,
  revokeAiConsent,
  type AiConsent
} from "../aiAssist";
import { deleteAccountAndData } from "../accountDeletion";

type Props = {
  calmMode: boolean;
  dropsBalance: number;
  // Drives child/guardian-managed AI consent copy. Child accounts require a
  // guardian to approve AI; the consent UI reflects that gate.
  isChildAccount?: boolean;
  onBack: () => void;
  onToggleCalm: (value: boolean) => void;
  onOpenWallet: () => void;
  onOpenStore: () => void;
  onOpenCreator: () => void;
  // Called after a successful account deletion + local wipe so the app can reset
  // back to a fresh, empty gallery.
  onDataWiped: () => void;
};

export function SettingsScreen({
  calmMode,
  dropsBalance,
  isChildAccount = false,
  onBack,
  onToggleCalm,
  onOpenWallet,
  onOpenStore,
  onOpenCreator,
  onDataWiped
}: Props) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [email, setEmail] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [consent, setConsent] = useState<AiConsent | null>(null);
  const [consentLoaded, setConsentLoaded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load the current session + AI consent on mount. Local mode resolves these
  // instantly (no network), so this is safe and never blocks the UI.
  useEffect(() => {
    let active = true;
    void Promise.all([getSession(), loadAiConsent()]).then(([nextSession, nextConsent]) => {
      if (!active) {
        return;
      }
      setSession(nextSession);
      setConsent(nextConsent);
      setConsentLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleEmailSignIn = useCallback(async () => {
    setAuthBusy(true);
    try {
      const result = await signInWithEmail(email);
      Alert.alert(result.ok ? "Check your email" : "Sign-in", result.message);
      if (result.ok) {
        setSession(await getSession());
      }
    } finally {
      setAuthBusy(false);
    }
  }, [email]);

  const handleProviderSignIn = useCallback(async (provider: OAuthProviderId) => {
    setAuthBusy(true);
    try {
      const result = await signInWithProvider(provider);
      Alert.alert("Sign-in", result.message);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    setAuthBusy(true);
    try {
      await signOut();
      setSession(null);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const handleRevokeConsent = useCallback(() => {
    Alert.alert(
      "Turn off AI Assist?",
      "Revoking is immediate and free. AI palette, prompt, and brush helpers will be disabled until you opt in again.",
      [
        { text: "Keep on", style: "cancel" },
        {
          text: "Turn off AI",
          style: "destructive",
          onPress: async () => {
            const next = await revokeAiConsent();
            setConsent(next);
          }
        }
      ]
    );
  }, []);

  const handleDelete = useCallback(() => {
    Alert.alert(
      "Delete my data & account?",
      "This permanently erases ALL Happy Paint data on this device — every painting, loop, replay, saved brush, palette, wallet balance, and settings. This cannot be undone.\n\nDeletion is free and always available; it is never tied to an account or purchase.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete everything",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteAccountAndData();
              setSession(null);
              setConsent(null);
              Alert.alert(
                "Your data was deleted",
                "Everything on this device has been erased and you've been signed out. Happy Paint has reset to a fresh start."
              );
              onDataWiped();
            } finally {
              setDeleting(false);
            }
          }
        }
      ]
    );
  }, [onDataWiped]);

  const label = sessionLabel(session);
  const consented = isAiConsented(consent);
  const consentRevoked = Boolean(consent && consent.revokedAt);
  const consentStale = Boolean(consent && consent.version !== AI_POLICY_VERSION);

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

      {/* --- Account & cloud sync (OPTIONAL — Store Review) ------------------ */}
      <Text style={styles.groupLabel}>Account & sync</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <View style={[styles.rowIcon, styles.accountIcon]}>
            {session ? <UserCircle size={22} color="#1d4ed8" /> : <CloudOff size={22} color="#64748b" />}
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{session ? "Signed in" : "Not signed in"}</Text>
            <Text style={styles.rowBody}>
              {session
                ? `${label}. Cloud sync keeps your work across devices.`
                : isCloudConfigured
                  ? "Sign in to sync your work across devices. An account is optional — Happy Paint works fully without one."
                  : LOCAL_ONLY_MESSAGE}
            </Text>
          </View>
        </View>

        {session ? (
          <View style={[styles.actionRow, styles.actionRowLast]}>
            <IconButton icon={LogOut} label="Sign out" onPress={() => void handleSignOut()} disabled={authBusy} />
          </View>
        ) : (
          <View style={styles.authBody}>
            <Text style={styles.optionalNote}>
              Signing in is optional. It only unlocks future cross-device sync and social features.
            </Text>
            <View style={styles.emailRow}>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
                editable={!authBusy}
              />
              <Pressable
                accessibilityRole="button"
                style={[styles.primaryBtn, authBusy && styles.btnDisabled]}
                disabled={authBusy}
                onPress={() => void handleEmailSignIn()}
              >
                <Text style={styles.primaryBtnText}>Send link</Text>
              </Pressable>
            </View>
            <View style={styles.providerRow}>
              {OAUTH_PROVIDERS.map((provider) => (
                <Pressable
                  key={provider.id}
                  accessibilityRole="button"
                  style={[styles.providerBtn, authBusy && styles.btnDisabled]}
                  disabled={authBusy}
                  onPress={() => void handleProviderSignIn(provider.id)}
                >
                  <Text style={styles.providerBtnText}>{provider.label}</Text>
                </Pressable>
              ))}
            </View>
            {authBusy ? <ActivityIndicator color="#0f766e" style={styles.authSpinner} /> : null}
          </View>
        )}
      </View>

      {/* --- AI Assist consent ---------------------------------------------- */}
      <Text style={styles.groupLabel}>AI Assist</Text>
      <View style={styles.section}>
        <View style={[styles.row, styles.rowLast]}>
          <View style={[styles.rowIcon, styles.aiIcon]}>
            <Sparkles size={22} color="#7c3aed" />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>
              {!consentLoaded
                ? "Checking AI status…"
                : consented
                  ? "AI Assist is on"
                  : "AI Assist is off"}
            </Text>
            <Text style={styles.rowBody}>
              {!consentLoaded
                ? " "
                : consented
                  ? `Local, on-device helpers only (palettes, prompts, brush recipes). Consent v${AI_POLICY_VERSION}. Revoke any time.`
                  : consentRevoked
                    ? "You turned AI Assist off. Open AI Assist to opt in again."
                    : consentStale
                      ? "The AI policy changed — open AI Assist to review and opt in again."
                      : isChildAccount
                        ? "AI Assist is off. On a child account a guardian must approve AI before it can be turned on."
                        : "Not enabled yet. Open AI Assist to opt in to local AI helpers."}
            </Text>
            {isChildAccount ? (
              <Text style={styles.guardianNote}>Guardian approval required for AI on this account.</Text>
            ) : null}
          </View>
          {consentLoaded && consented ? (
            <Pressable accessibilityRole="button" style={styles.revokeBtn} onPress={handleRevokeConsent}>
              <Text style={styles.revokeBtnText}>Turn off</Text>
            </Pressable>
          ) : null}
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

      {/* --- Account deletion (App Review requirement) ---------------------- */}
      <Text style={styles.groupLabel}>Data & privacy</Text>
      <View style={[styles.section, styles.dangerSection]}>
        <Pressable
          accessibilityRole="button"
          style={[styles.navRow, styles.navRowLast]}
          disabled={deleting}
          onPress={handleDelete}
        >
          <View style={[styles.rowIcon, styles.dangerIcon]}>
            <Trash2 size={22} color="#b91c1c" />
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, styles.dangerTitle]}>Delete my data & account</Text>
            <Text style={styles.rowBody}>
              Permanently erase everything on this device. Free, always available, and never tied to an account or
              purchase.
            </Text>
          </View>
          {deleting ? <ActivityIndicator color="#b91c1c" /> : <ChevronRight size={22} color="#fca5a5" />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  accountIcon: {
    backgroundColor: "#eff6ff"
  },
  actionRow: {
    alignItems: "flex-start",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: 1,
    flexDirection: "row",
    paddingBottom: 14
  },
  actionRowLast: {
    borderBottomWidth: 0
  },
  aiIcon: {
    backgroundColor: "#f5f3ff"
  },
  authBody: {
    borderTopColor: "#e5e7eb",
    borderTopWidth: 1,
    gap: 10,
    paddingBottom: 14,
    paddingTop: 12
  },
  authSpinner: {
    alignSelf: "flex-start"
  },
  btnDisabled: {
    opacity: 0.5
  },
  creatorIcon: {
    backgroundColor: "#f5f3ff"
  },
  dangerIcon: {
    backgroundColor: "#fee2e2"
  },
  dangerSection: {
    borderColor: "#fecaca"
  },
  dangerTitle: {
    color: "#b91c1c"
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
  emailRow: {
    flexDirection: "row",
    gap: 8
  },
  groupLabel: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 8,
    marginTop: 4,
    textTransform: "uppercase"
  },
  guardianNote: {
    color: "#7c3aed",
    fontSize: 13,
    fontWeight: "800",
    marginTop: 6
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 20
  },
  input: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    color: "#0f172a",
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10
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
  optionalNote: {
    color: "#64748b",
    fontSize: 13,
    lineHeight: 19
  },
  primaryBtn: {
    alignItems: "center",
    backgroundColor: "#0f766e",
    borderRadius: 8,
    justifyContent: "center",
    paddingHorizontal: 16
  },
  primaryBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800"
  },
  providerBtn: {
    alignItems: "center",
    backgroundColor: "#111827",
    borderRadius: 8,
    flex: 1,
    paddingVertical: 11
  },
  providerBtnText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700"
  },
  providerRow: {
    flexDirection: "row",
    gap: 8
  },
  revokeBtn: {
    backgroundColor: "#ede9fe",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  revokeBtnText: {
    color: "#6d28d9",
    fontSize: 13,
    fontWeight: "800"
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
  rowLast: {
    borderBottomWidth: 0
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
