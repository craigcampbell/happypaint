import { ArrowLeft, Shuffle, Sparkles, Wand } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { IconButton } from "./IconButton";
import {
  AI_POLICY_VERSION,
  brushRecipeFromText,
  generatePaletteFromTheme,
  isAiConsented,
  loadAiConsent,
  revokeAiConsent,
  saveAiConsent,
  shufflePrompt,
  type AiConsent,
  type AiProfileKind,
  type BrushRecipeGeneration,
  type PaletteGeneration,
  type PromptGeneration
} from "../aiAssist";
import type { BrushRecipe } from "../types";

type Props = {
  onBack: () => void;
  // Apply a generated palette's colors (first becomes the active color).
  onApplyPalette: (colors: string[]) => void;
  // Apply a brush recipe to the live BrushSettings.
  onApplyRecipe: (recipe: BrushRecipe) => void;
};

// One-time consent gate. For a child/guardian-managed account, guardian
// approval is required and a visible gate blocks use (mirrors ai_consent).
function ConsentGate({ onConsent }: { onConsent: (record: { guardianApproved: boolean; profileKind: AiProfileKind }) => void }) {
  const [profileKind, setProfileKind] = useState<AiProfileKind>("self");
  const [guardianApproved, setGuardianApproved] = useState(false);
  const isChild = profileKind === "child";
  const canConsent = !isChild || guardianApproved;

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Turn on AI Assist</Text>
      <Text style={styles.bodyText}>
        AI Assist v1 runs entirely on your device — no data leaves it, no external model is called. It helps you start
        art (palettes, prompts, brush recipes); it never makes finished art for you.
      </Text>
      <Text style={styles.noteText}>
        Policy version {AI_POLICY_VERSION}. Every helper is labeled AI-assisted. Anything you save starts as pending
        moderation. You can turn AI off again any time.
      </Text>

      <View style={styles.segmentRow}>
        {(["self", "child"] as AiProfileKind[]).map((kind) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: profileKind === kind }}
            key={kind}
            onPress={() => setProfileKind(kind)}
            style={[styles.segment, profileKind === kind && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, profileKind === kind && styles.segmentTextActive]}>
              {kind === "self" ? "Mine (teen/adult)" : "A child I manage"}
            </Text>
          </Pressable>
        ))}
      </View>

      {isChild ? (
        <View style={styles.switchRow}>
          <Text style={styles.controlLabel}>Guardian approves AI Assist</Text>
          <Switch onValueChange={setGuardianApproved} value={guardianApproved} />
        </View>
      ) : null}

      {isChild && !guardianApproved ? (
        <Text style={styles.noteText}>A guardian must approve AI Assist for a child account before it can be used.</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        disabled={!canConsent}
        onPress={() => onConsent({ guardianApproved, profileKind })}
        style={[styles.primaryButton, !canConsent && styles.primaryButtonDisabled]}
      >
        <Text style={styles.primaryButtonText}>Turn on AI Assist</Text>
      </Pressable>
    </View>
  );
}

export function AiAssistScreen({ onBack, onApplyPalette, onApplyRecipe }: Props) {
  const [consent, setConsent] = useState<AiConsent | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [theme, setTheme] = useState("neon arcade");
  const [palette, setPalette] = useState<PaletteGeneration | null>(null);

  const [prompt, setPrompt] = useState<PromptGeneration | null>(null);

  const [brushText, setBrushText] = useState("scratchy pencil");
  const [recipe, setRecipe] = useState<BrushRecipeGeneration | null>(null);

  useEffect(() => {
    let active = true;
    void loadAiConsent().then((record) => {
      if (active) {
        setConsent(record);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const consented = isAiConsented(consent);

  const grantConsent = useCallback(async (record: { guardianApproved: boolean; profileKind: AiProfileKind }) => {
    const saved = await saveAiConsent(record);
    setConsent(saved);
  }, []);

  const turnOff = useCallback(async () => {
    const revoked = await revokeAiConsent();
    setConsent(revoked);
    Alert.alert("AI Assist off", "AI helpers are turned off. You can turn them back on any time.");
  }, []);

  const runPalette = useCallback(() => setPalette(generatePaletteFromTheme(theme)), [theme]);
  const shuffleCard = useCallback(() => setPrompt(shufflePrompt()), []);
  const runRecipe = useCallback(() => setRecipe(brushRecipeFromText(brushText)), [brushText]);

  if (!loaded) {
    return (
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.header}>
          <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
          <View style={styles.titleBlock}>
            <Text style={styles.title}>AI Assist</Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>AI Assist</Text>
          <Text style={styles.subtitle}>On-device, deterministic helpers. No data leaves your device.</Text>
        </View>
      </View>

      {!consented ? (
        <ConsentGate onConsent={(record) => void grantConsent(record)} />
      ) : (
        <>
          {/* Palette from theme */}
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <Sparkles size={20} color="#0f172a" />
              <Text style={styles.panelTitle}>Palette from a theme</Text>
            </View>
            <TextInput
              onChangeText={setTheme}
              placeholder="e.g. neon arcade, underwater, autumn"
              style={styles.input}
              value={theme}
            />
            <View style={styles.toolbar}>
              <IconButton icon={Wand} label="Make palette" onPress={runPalette} />
            </View>
            {palette ? (
              <>
                <View style={styles.swatches}>
                  {palette.output.colors.map((color, idx) => (
                    <View key={`${color}-${idx}`} style={[styles.swatch, { backgroundColor: color }]} />
                  ))}
                </View>
                <Text style={styles.noteText}>AI-assisted ({palette.input.rule}) · pending moderation if saved.</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onApplyPalette(palette.output.colors)}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>Use this palette</Text>
                </Pressable>
              </>
            ) : null}
          </View>

          {/* Kid-safe prompt cards */}
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <Shuffle size={20} color="#0f172a" />
              <Text style={styles.panelTitle}>Prompt cards</Text>
            </View>
            <Text style={styles.bodyText}>Curated, kid-safe drawing ideas. No free-text generation.</Text>
            <View style={styles.toolbar}>
              <IconButton icon={Shuffle} label="Shuffle a prompt" onPress={shuffleCard} />
            </View>
            {prompt ? (
              <View style={styles.promptCard}>
                <Text style={styles.promptCategory}>{prompt.output.category}</Text>
                <Text style={styles.promptText}>{prompt.output.prompt}</Text>
              </View>
            ) : null}
          </View>

          {/* Brush recipe from plain language */}
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <Wand size={20} color="#0f172a" />
              <Text style={styles.panelTitle}>Brush from words</Text>
            </View>
            <TextInput
              onChangeText={setBrushText}
              placeholder='e.g. "soft marker", "glitter gel pen", "thick paint"'
              style={styles.input}
              value={brushText}
            />
            <View style={styles.toolbar}>
              <IconButton icon={Wand} label="Make brush" onPress={runRecipe} />
            </View>
            {recipe ? (
              <>
                <Text style={styles.bodyText}>
                  {recipe.output.brush_recipe.baseBrush}
                  {recipe.output.brush_recipe.glow ? " · glow" : ""}
                  {recipe.output.brush_recipe.spray ? " · spray" : ""} · size {recipe.output.brush_recipe.size} · opacity{" "}
                  {Math.round(recipe.output.brush_recipe.opacity * 100)}%
                </Text>
                <Text style={styles.noteText}>
                  {recipe.input.matched ? "AI-assisted" : "No keywords matched — using a sensible default"}.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onApplyRecipe(recipe.output.brush_recipe)}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>Use this brush</Text>
                </Pressable>
              </>
            ) : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.noteText}>
              Server-side helpers (like sketch cleanup) are deferred behind credits + moderation in a later version.
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void turnOff()} style={styles.ghostButton}>
              <Text style={styles.ghostButtonText}>Turn off AI Assist</Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20
  },
  controlLabel: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "900"
  },
  ghostButton: {
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 8,
    marginTop: 10,
    paddingVertical: 12
  },
  ghostButtonText: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800"
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  input: {
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  noteText: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12
  },
  panelHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  panelTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#0f766e",
    borderRadius: 8,
    paddingVertical: 12
  },
  primaryButtonDisabled: {
    opacity: 0.45
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800"
  },
  promptCard: {
    backgroundColor: "#ecfeff",
    borderColor: "#0f766e",
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
    padding: 14
  },
  promptCategory: {
    color: "#0f766e",
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase"
  },
  promptText: {
    color: "#0f172a",
    fontSize: 17,
    fontWeight: "800"
  },
  screen: {
    gap: 14,
    padding: 16,
    paddingBottom: 28
  },
  segment: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    minHeight: 40,
    minWidth: 120,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  segmentActive: {
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
    fontSize: 14,
    fontWeight: "800"
  },
  segmentTextActive: {
    color: "#134e4a"
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  switchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between"
  },
  swatch: {
    borderColor: "#ffffff",
    borderRadius: 10,
    borderWidth: 2,
    height: 40,
    width: 40
  },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  title: {
    color: "#0f172a",
    fontSize: 22,
    fontWeight: "900"
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  }
});
