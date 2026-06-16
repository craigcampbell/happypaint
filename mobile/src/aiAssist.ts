// AI Assist v1 — LOCAL & DETERMINISTIC helpers (docs/ai-policy.md §"Allowed AI v1").
// Mirrors src/utils/aiAssist.js, adapted to RN/AsyncStorage + Happy Paint types.
//
// Per the AI policy, v1 favors local deterministic helpers: they work offline,
// no user data leaves the device, there is no external model risk, and no
// per-call vendor cost. THIS MODULE MAKES NO NETWORK / MODEL CALLS. Everything
// here is a pure function over its inputs (plus the consent store, which is
// local AsyncStorage).
//
// Helpers (all `ai_generations.kind` in the schema):
//   - palette      : theme word/phrase -> harmonious HSL palette (hash -> seed)
//   - prompt_card  : curated, pre-approved drawing prompts; "shuffle"
//   - brush_recipe : plain-language phrase -> brush recipe (size/opacity/...)
//
// Consent is recorded locally (mirrors `ai_consent`: version + consentedAt, and
// for a child/guardian-managed account a visible guardian-approval gate). Outputs
// that could be shared/saved carry `moderation_status: 'pending'` (mirrors
// `ai_generations`) so the publish/moderation pipeline (a later agent) can act
// on them. Server-side helpers (sketch cleanup, etc.) are DEFERRED behind
// credits + moderation and are intentionally not implemented here.

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { BrushRecipe } from "./types";

// Must match docs/ai-policy.md "Current consent version string in use".
export const AI_POLICY_VERSION = "2026-06-15";

// `model: null` mirrors ai_generations.model for local/deterministic helpers.
export const LOCAL_MODEL = null;

const CONSENT_KEY = "happy-paint:ai-consent:v1";

export type AiGenerationKind = "palette" | "prompt_card" | "brush_recipe";

// Shape mirrors ai_generations rows (input/output/kind/model/consent_version/
// moderation_status) so saved outputs are sync-ready and consistently labeled.
export type AiGeneration<TInput, TOutput> = {
  kind: AiGenerationKind;
  model: null;
  consent_version: string;
  moderation_status: "pending";
  input: TInput;
  output: TOutput;
};

// ---- Consent (mirrors ai_consent) -----------------------------------------

export type AiProfileKind = "self" | "child";

// Shape mirrors ai_consent: version + consentedAt + revokedAt + (for child
// accounts) guardian approval gate + profileKind.
export type AiConsent = {
  version: string;
  consentedAt: string;
  revokedAt: string | null;
  guardianApproved: boolean;
  profileKind: AiProfileKind;
};

export async function loadAiConsent(): Promise<AiConsent | null> {
  try {
    const raw = await AsyncStorage.getItem(CONSENT_KEY);
    return raw ? (JSON.parse(raw) as AiConsent) : null;
  } catch {
    return null;
  }
}

// Persist a consent grant. For a child/guardian-managed account, guardian
// approval is required; a visible gate is enough for this local v1.
export async function saveAiConsent(record: {
  guardianApproved?: boolean;
  profileKind?: AiProfileKind;
}): Promise<AiConsent> {
  const value: AiConsent = {
    version: AI_POLICY_VERSION,
    consentedAt: new Date().toISOString(),
    revokedAt: null,
    guardianApproved: Boolean(record.guardianApproved),
    profileKind: record.profileKind ?? "self"
  };
  try {
    await AsyncStorage.setItem(CONSENT_KEY, JSON.stringify(value));
  } catch {
    // non-fatal — consent just won't persist in a blocked store
  }
  return value;
}

// Revoke consent (immediate, never gated — policy §Revocation).
export async function revokeAiConsent(): Promise<AiConsent> {
  const current = (await loadAiConsent()) ?? {
    version: AI_POLICY_VERSION,
    consentedAt: new Date().toISOString(),
    revokedAt: null,
    guardianApproved: false,
    profileKind: "self" as AiProfileKind
  };
  const value: AiConsent = { ...current, version: AI_POLICY_VERSION, revokedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(CONSENT_KEY, JSON.stringify(value));
  } catch {
    // non-fatal
  }
  return value;
}

// Is AI usable right now? Consent must be present, for the current policy
// version, not revoked, and — for a child account — guardian-approved.
export function isAiConsented(consent: AiConsent | null | undefined): boolean {
  if (!consent) {
    return false;
  }
  if (consent.version !== AI_POLICY_VERSION) {
    return false; // policy bumped -> re-collect consent (policy §Versioned)
  }
  if (consent.revokedAt) {
    return false;
  }
  if (consent.profileKind === "child" && !consent.guardianApproved) {
    return false;
  }
  return true;
}

// ---- Deterministic hashing -------------------------------------------------

// FNV-1a 32-bit hash of a string -> stable unsigned int seed. Deterministic so
// the same theme always yields the same palette (no randomness, offline-safe).
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  const value = String(text || "").trim().toLowerCase();
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

// Small deterministic PRNG (mulberry32) seeded from the hash.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Color helpers ---------------------------------------------------------

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const lum = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lum - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Harmony rules selected deterministically by the seed.
export const HARMONY_RULES = ["analogous", "complementary", "triad"] as const;
export type HarmonyRule = (typeof HARMONY_RULES)[number];

// ---- Palette from theme (kind: 'palette') ----------------------------------

export type PaletteGeneration = AiGeneration<{ theme: string; rule: HarmonyRule }, { colors: string[] }>;

// Deterministically generate a harmonious palette from a theme word/phrase.
export function generatePaletteFromTheme(theme: string): PaletteGeneration {
  const seed = hashString(theme || "happy paint");
  const rand = mulberry32(seed);
  const baseHue = seed % 360;
  const rule = HARMONY_RULES[seed % HARMONY_RULES.length];
  const baseSat = 0.55 + rand() * 0.3; // 0.55..0.85
  const colors: string[] = [];

  // A dark anchor + a light anchor frame every palette (good for line + paper).
  colors.push(hslToHex(baseHue, 0.35 + rand() * 0.2, 0.14)); // dark
  colors.push(hslToHex((baseHue + 30) % 360, 0.25, 0.95)); // light

  let hueOffsets: number[];
  if (rule === "complementary") {
    hueOffsets = [0, 180, 30, 210, 60];
  } else if (rule === "triad") {
    hueOffsets = [0, 120, 240, 60, 180];
  } else {
    hueOffsets = [0, 30, -30, 60, -60];
  }

  for (let i = 0; i < hueOffsets.length; i += 1) {
    const lum = 0.42 + (i % 3) * 0.12; // spread tones 0.42..0.66
    colors.push(hslToHex(baseHue + hueOffsets[i], baseSat, lum));
  }

  // De-dupe while preserving order; cap at 8 swatches.
  const seen = new Set<string>();
  const palette: string[] = [];
  for (const color of colors) {
    if (!seen.has(color)) {
      seen.add(color);
      palette.push(color);
    }
    if (palette.length >= 8) {
      break;
    }
  }

  return {
    kind: "palette",
    model: LOCAL_MODEL,
    consent_version: AI_POLICY_VERSION,
    moderation_status: "pending",
    input: { theme: String(theme || "").trim(), rule },
    output: { colors: palette }
  };
}

// ---- Kid-safe prompt cards (kind: 'prompt_card') ---------------------------
// A curated, pre-approved local library (policy: never free-form open
// generation in kid_safe).

export const PROMPT_LIBRARY: Array<{ category: string; prompts: string[] }> = [
  {
    category: "Animals",
    prompts: [
      "A cat astronaut floating among the stars",
      "A friendly dragon who loves to paint",
      "A penguin having a beach day",
      "A fox wearing a cozy scarf",
      "A whale carrying a tiny island on its back"
    ]
  },
  {
    category: "Places",
    prompts: [
      "A treehouse city in the clouds",
      "An underwater candy shop",
      "A cozy cabin in a glowing forest",
      "A neon arcade at midnight",
      "A floating market on rainbow boats"
    ]
  },
  {
    category: "Fantasy",
    prompts: [
      "A robot tending a garden of light bulbs",
      "A wizard's hat full of stars",
      "A door that opens to a different season",
      "A creature made of clouds and music",
      "A map to a place that doesn't exist yet"
    ]
  },
  {
    category: "Feelings",
    prompts: [
      "Draw what 'excited' looks like as a color burst",
      "A calm scene you'd want to nap in",
      "Your happiest place as a tiny world",
      "What 'curious' would look like as a creature",
      "A self-portrait as your favorite animal"
    ]
  }
];

export type PromptGeneration = AiGeneration<{ seed: number; library: string }, { category: string; prompt: string }>;

// Deterministic-by-seed prompt pick. When no seed is given, derive one from the
// clock so "shuffle" feels fresh each tap.
export function shufflePrompt(seed?: number): PromptGeneration {
  const all: Array<{ category: string; prompt: string }> = [];
  for (const group of PROMPT_LIBRARY) {
    for (const prompt of group.prompts) {
      all.push({ category: group.category, prompt });
    }
  }
  const s = typeof seed === "number" ? seed >>> 0 : Date.now() >>> 0;
  const pick = all[s % all.length];
  return {
    kind: "prompt_card",
    model: LOCAL_MODEL,
    consent_version: AI_POLICY_VERSION,
    moderation_status: "pending",
    input: { seed: s, library: "curated_v1" },
    output: { category: pick.category, prompt: pick.prompt }
  };
}

// ---- Brush recipe from plain language (kind: 'brush_recipe') ---------------
// Maps phrases to existing Happy Paint brush parameters. Produces a recipe, not
// images (policy). Deterministic keyword matching — no model.

const BRUSH_KEYWORDS: Array<{ match: string[]; settings: Partial<BrushRecipe> }> = [
  // base brush types
  { match: ["pencil", "sketch"], settings: { baseBrush: "pencil", size: 10, opacity: 0.6, variation: 0.18 } },
  { match: ["marker"], settings: { baseBrush: "marker", size: 26, opacity: 0.9, variation: 0.05 } },
  { match: ["paint", "gouache", "acrylic"], settings: { baseBrush: "paint", size: 40, opacity: 0.85, variation: 0.1 } },
  { match: ["spray", "airbrush", "air brush"], settings: { baseBrush: "spray", spray: true, size: 48, opacity: 0.5, variation: 0.2 } },
  { match: ["glow", "neon", "glitter", "gel pen", "gel"], settings: { baseBrush: "glow", glow: true, size: 22, opacity: 0.85, variation: 0.12 } },
  // modifiers
  { match: ["scratchy", "rough", "dry"], settings: { variation: 0.32, opacity: 0.55 } },
  { match: ["soft", "smooth", "gentle"], settings: { opacity: 0.6, variation: 0.04 } },
  { match: ["thick", "chunky", "bold", "heavy"], settings: { size: 64 } },
  { match: ["thin", "fine", "tiny", "small"], settings: { size: 6 } },
  { match: ["light", "faint", "pale"], settings: { opacity: 0.35 } },
  { match: ["solid", "opaque", "strong"], settings: { opacity: 1 } }
];

export type BrushRecipeGeneration = AiGeneration<{ text: string; matched: boolean }, { brush_recipe: BrushRecipe }>;

// Returns an ai_generations-shaped record whose `output.brush_recipe` mirrors
// the typed space_assets.brush_recipe slot so it can be saved by Brush Studio.
export function brushRecipeFromText(text: string): BrushRecipeGeneration {
  const phrase = String(text || "").trim().toLowerCase();
  let settings: BrushRecipe = { baseBrush: "marker", size: 24, opacity: 0.86, variation: 0.08, glow: false, spray: false };
  let matched = false;
  for (const entry of BRUSH_KEYWORDS) {
    if (entry.match.some((keyword) => phrase.includes(keyword))) {
      settings = { ...settings, ...entry.settings };
      matched = true;
    }
  }
  const recipe: BrushRecipe = {
    baseBrush: settings.baseBrush,
    size: Math.min(120, Math.max(2, Math.round(settings.size))),
    opacity: Math.min(1, Math.max(0, settings.opacity)),
    variation: Math.min(1, Math.max(0, settings.variation)),
    glow: Boolean(settings.glow),
    spray: Boolean(settings.spray)
  };
  return {
    kind: "brush_recipe",
    model: LOCAL_MODEL,
    consent_version: AI_POLICY_VERSION,
    moderation_status: "pending",
    input: { text: String(text || "").trim(), matched },
    output: { brush_recipe: recipe }
  };
}
