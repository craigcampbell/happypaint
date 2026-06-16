import Slider from "@react-native-community/slider";
import { ArrowLeft, Check, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Canvas, Group, Path, Skia } from "@shopify/react-native-skia";

import { IconButton } from "./IconButton";
import {
  buildBrushAssetFields,
  DEFAULT_RECIPE,
  normalizeRecipe,
  RECIPE_BASE_BRUSHES,
  recipeFromAsset,
  recipeToBrushSettings
} from "../brushStudio";
import { loadSpaceAssets, makeSpaceAssetId, upsertSpaceAsset } from "../paintSpace";
import type { BrushId, BrushRecipe, BrushSettings, SpaceAsset } from "../types";

type Props = {
  onBack: () => void;
  // Selected swatch from the studio (used as the preview/apply color).
  color: string;
  // Apply a recipe to the live BrushSettings.
  onApplyRecipe: (patch: Partial<BrushSettings>) => void;
};

const PREVIEW_WIDTH = 280;
const PREVIEW_HEIGHT = 110;
const CARD_PREVIEW_WIDTH = 150;
const CARD_PREVIEW_HEIGHT = 56;

// Build a smooth S-curve SkPath across a preview box (representative stroke).
function buildPreviewPath(width: number, height: number) {
  const path = Skia.Path.Make();
  const steps = 36;
  const margin = Math.min(width, height) * 0.18;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = margin + t * (width - margin * 2);
    const y = height / 2 + Math.sin(t * Math.PI * 2) * (height * 0.26);
    if (i === 0) {
      path.moveTo(x, y);
    } else {
      path.lineTo(x, y);
    }
  }
  return path;
}

// A live Skia preview of a recipe rendered as one stroke. Mirrors the studio's
// per-brush styling (marker/pencil/paint/spray/glow) closely enough for a swatch.
function RecipePreview({
  recipe,
  color,
  width = PREVIEW_WIDTH,
  height = PREVIEW_HEIGHT
}: {
  recipe: BrushRecipe;
  color: string;
  width?: number;
  height?: number;
}) {
  const settings = useMemo(() => recipeToBrushSettings(recipe), [recipe]);
  const path = useMemo(() => buildPreviewPath(width, height), [width, height]);
  const brush = (settings.brush ?? "marker") as BrushId;
  const size = settings.size ?? recipe.size;
  const opacity = settings.opacity ?? recipe.opacity;

  let nodes: ReactNode;
  if (brush === "glow") {
    nodes = (
      <Group>
        <Path color={color} opacity={opacity * 0.34} path={path} strokeCap="round" strokeJoin="round" strokeWidth={size * 1.6} style="stroke" />
        <Path color={color} opacity={opacity * 0.84} path={path} strokeCap="round" strokeJoin="round" strokeWidth={size * 0.82} style="stroke" />
        <Path color="#ffffff" opacity={opacity * 0.36} path={path} strokeCap="round" strokeJoin="round" strokeWidth={Math.max(1, size * 0.22)} style="stroke" />
      </Group>
    );
  } else if (brush === "pencil") {
    nodes = (
      <Path color={color} opacity={opacity * 0.72} path={path} strokeCap="round" strokeJoin="round" strokeWidth={Math.max(1, size * 0.62)} style="stroke" />
    );
  } else if (brush === "paint") {
    nodes = (
      <Path color={color} opacity={opacity * 0.82} path={path} strokeCap="round" strokeJoin="round" strokeWidth={size * 1.08} style="stroke" />
    );
  } else if (brush === "spray") {
    // Approximate spray with a soft wide low-opacity stroke for the swatch.
    nodes = (
      <Path color={color} opacity={opacity * 0.5} path={path} strokeCap="round" strokeJoin="round" strokeWidth={size * 1.2} style="stroke" />
    );
  } else {
    nodes = (
      <Path color={color} opacity={opacity} path={path} strokeCap="round" strokeJoin="round" strokeWidth={size} style="stroke" />
    );
  }

  return (
    <View style={[styles.preview, { height }]}>
      <Canvas style={{ width, height }}>{nodes}</Canvas>
    </View>
  );
}

export function BrushStudioScreen({ onBack, color, onApplyRecipe }: Props) {
  const [recipe, setRecipe] = useState<BrushRecipe>(() => normalizeRecipe(DEFAULT_RECIPE));
  const [name, setName] = useState("My Brush");
  const [tagsText, setTagsText] = useState("");
  const [saved, setSaved] = useState<SpaceAsset[]>([]);

  const refresh = useCallback(async () => {
    const assets = await loadSpaceAssets();
    setSaved(assets.filter((asset) => asset.kind === "brush"));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchRecipe = useCallback((patch: Partial<BrushRecipe>) => {
    setRecipe((current) => normalizeRecipe({ ...current, ...patch }));
  }, []);

  const saveBrush = useCallback(async () => {
    const tags = tagsText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const fields = buildBrushAssetFields(recipe, { tags });
    const asset: SpaceAsset = {
      id: makeSpaceAssetId(),
      kind: "brush",
      title: name.trim() || "My Brush",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...fields
    };
    await upsertSpaceAsset(asset);
    await refresh();
    Alert.alert("Saved to Paint Space", "Your brush is in the locker. Apply it any time.");
  }, [name, recipe, refresh, tagsText]);

  const applyCurrent = useCallback(() => {
    onApplyRecipe(recipeToBrushSettings(recipe));
    Alert.alert("Brush applied", "Your custom brush is now selected in the studio.");
  }, [onApplyRecipe, recipe]);

  const applySaved = useCallback(
    (asset: SpaceAsset) => {
      onApplyRecipe(recipeToBrushSettings(recipeFromAsset(asset)));
      Alert.alert("Brush applied", `${asset.title} is now selected in the studio.`);
    },
    [onApplyRecipe]
  );

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Back" onPress={onBack} />
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Brush Studio</Text>
          <Text style={styles.subtitle}>Build a brush recipe, preview it, save it to your locker.</Text>
        </View>
      </View>

      <View style={styles.panel}>
        <RecipePreview color={color} recipe={recipe} />

        <Text style={styles.controlLabel}>Base brush</Text>
        <View style={styles.segmentRow}>
          {RECIPE_BASE_BRUSHES.map((base) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: recipe.baseBrush === base.id }}
              key={base.id}
              onPress={() => patchRecipe({ baseBrush: base.id })}
              style={[styles.segment, recipe.baseBrush === base.id && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, recipe.baseBrush === base.id && styles.segmentTextActive]}>{base.label}</Text>
            </Pressable>
          ))}
        </View>

        <SliderControl label="Size" maximum={120} minimum={2} step={1} value={recipe.size} onChange={(size) => patchRecipe({ size })} />
        <SliderControl
          label="Opacity"
          maximum={1}
          minimum={0.05}
          step={0.05}
          value={recipe.opacity}
          onChange={(opacity) => patchRecipe({ opacity })}
        />
        <SliderControl
          label="Variation"
          maximum={1}
          minimum={0}
          step={0.05}
          value={recipe.variation}
          onChange={(variation) => patchRecipe({ variation })}
        />

        <View style={styles.switchRow}>
          <Text style={styles.controlLabel}>Glow halo</Text>
          <Switch onValueChange={(glow) => patchRecipe({ glow })} value={recipe.glow} />
        </View>
        <View style={styles.switchRow}>
          <Text style={styles.controlLabel}>Spray scatter</Text>
          <Switch onValueChange={(spray) => patchRecipe({ spray })} value={recipe.spray} />
        </View>

        <View style={styles.toolbar}>
          <IconButton icon={Check} label="Apply now" onPress={applyCurrent} />
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Save to Paint Space</Text>
        <TextInput onChangeText={setName} placeholder="Brush name" style={styles.input} value={name} />
        <TextInput onChangeText={setTagsText} placeholder="Tags (comma separated)" style={styles.input} value={tagsText} />
        <View style={styles.toolbar}>
          <IconButton icon={Sparkles} label="Save brush" onPress={() => void saveBrush()} />
        </View>
      </View>

      {saved.length > 0 ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>My brushes</Text>
          <View style={styles.grid}>
            {saved.map((asset) => {
              const assetRecipe = recipeFromAsset(asset);
              const tags = (asset.payload as { tags?: string[] } | undefined)?.tags ?? [];
              return (
                <View key={asset.id} style={styles.card}>
                  <RecipePreview color={color} height={CARD_PREVIEW_HEIGHT} recipe={assetRecipe} width={CARD_PREVIEW_WIDTH} />
                  <Text numberOfLines={1} style={styles.cardTitle}>
                    {asset.title}
                  </Text>
                  {tags.length > 0 ? (
                    <Text numberOfLines={1} style={styles.cardTags}>
                      {tags.join(" · ")}
                    </Text>
                  ) : null}
                  <Pressable accessibilityRole="button" onPress={() => applySaved(asset)} style={styles.cardButton}>
                    <Text style={styles.cardButtonText}>Apply</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function SliderControl({
  label,
  maximum,
  minimum,
  onChange,
  step,
  value
}: {
  label: string;
  maximum: number;
  minimum: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const displayValue = maximum <= 1 ? Math.round(value * 100) : Math.round(value);
  return (
    <View style={styles.sliderRow}>
      <View style={styles.sliderHeader}>
        <Text style={styles.controlLabel}>{label}</Text>
        <Text style={styles.valueLabel}>{displayValue}</Text>
      </View>
      <Slider
        maximumTrackTintColor="#cbd5e1"
        maximumValue={maximum}
        minimumTrackTintColor="#0f766e"
        minimumValue={minimum}
        onValueChange={onChange}
        step={step}
        thumbTintColor="#0f766e"
        value={value}
      />
    </View>
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
    gap: 6,
    overflow: "hidden",
    padding: 8
  },
  cardButton: {
    alignItems: "center",
    backgroundColor: "#0f766e",
    borderRadius: 8,
    paddingVertical: 8
  },
  cardButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800"
  },
  cardTags: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  cardTitle: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800"
  },
  controlLabel: {
    color: "#334155",
    fontSize: 14,
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
  input: {
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
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
    backgroundColor: "#f7f1e5",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    overflow: "hidden",
    width: "100%"
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
    minWidth: 76,
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
  sliderHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  sliderRow: {
    marginTop: 4
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
  },
  valueLabel: {
    color: "#0f766e",
    fontSize: 13,
    fontWeight: "900"
  }
});
