// AI Assist v1 — LOCAL & DETERMINISTIC helpers (docs/ai-policy.md §"Allowed AI v1").
//
// Per the AI policy, v1 favors local deterministic helpers: they work offline,
// no user data leaves the device, there is no external model risk, and no
// per-call vendor cost. THIS MODULE MAKES NO NETWORK / MODEL CALLS. Everything
// here is a pure function over its inputs (plus the consent store, which is
// local IndexedDB/localStorage).
//
// Helpers implemented (all `ai_generations.kind` in the schema):
//   - palette     : theme word/phrase -> harmonious HSL palette (hash -> seed)
//   - prompt_card : curated, pre-approved drawing prompts; "shuffle"
//   - brush_recipe: plain-language phrase -> brush settings (size/opacity/...)
//
// Consent is recorded locally (mirrors `ai_consent`: version + consentedAt, and
// for child/guardian-managed accounts a visible guardian-approval gate). Outputs
// that could be shared/saved carry `moderation_status: 'pending'` (mirrors
// `ai_generations`) so the publish/moderation pipeline (a later agent) can act
// on them. Server-side helpers (sketch cleanup, etc.) are DEFERRED behind
// credits + moderation and are intentionally not implemented here.

import { idbGetKV, idbSetKV, isIdbAvailable } from "./idb";

// Must match docs/ai-policy.md "Current consent version string in use".
export const AI_POLICY_VERSION = "2026-06-15";

// `model: null` mirrors ai_generations.model for local/deterministic helpers.
export const LOCAL_MODEL = null;

const CONSENT_IDB_KEY = "ai-consent:v1";
const CONSENT_STORAGE_KEY = "happypaint:ai-consent:v1";

// ---- Consent (mirrors ai_consent) -----------------------------------------

// Load the local consent record, or null if none / unavailable. Shape mirrors
// ai_consent: { version, consentedAt, revokedAt, guardianApproved, profileKind }.
export async function loadAiConsent() {
  if (isIdbAvailable()) {
    try {
      const record = await idbGetKV(CONSENT_IDB_KEY);
      if (record && typeof record === "object") {
        return record;
      }
    } catch {
      // fall through to localStorage
    }
  }
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Persist a consent grant. For a child/guardian-managed account, guardian
// approval is required; a visible gate is enough for this local v1.
export async function saveAiConsent(record) {
  const value = {
    version: AI_POLICY_VERSION,
    consentedAt: new Date().toISOString(),
    revokedAt: null,
    guardianApproved: Boolean(record?.guardianApproved),
    profileKind: record?.profileKind || "self", // 'self' | 'child'
  };
  if (isIdbAvailable()) {
    try {
      await idbSetKV(CONSENT_IDB_KEY, value);
      return value;
    } catch {
      // fall through to localStorage
    }
  }
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // non-fatal — consent just won't persist in a full/blocked store
  }
  return value;
}

// Revoke consent (immediate, never gated — policy §Revocation).
export async function revokeAiConsent() {
  const current = (await loadAiConsent()) || {};
  const value = { ...current, version: AI_POLICY_VERSION, revokedAt: new Date().toISOString() };
  if (isIdbAvailable()) {
    try {
      await idbSetKV(CONSENT_IDB_KEY, value);
      return value;
    } catch {
      // fall through
    }
  }
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // non-fatal
  }
  return value;
}

// Is AI usable right now? Consent must be present, for the current policy
// version, not revoked, and — for a child account — guardian-approved.
export function isAiConsented(consent) {
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
function hashString(text) {
  let hash = 0x811c9dc5;
  const value = String(text || "").trim().toLowerCase();
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids float precision loss).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

// Small deterministic PRNG (mulberry32) seeded from the hash, for any secondary
// jitter we want to stay stable across runs.
function mulberry32(seed) {
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

function hslToHex(h, s, l) {
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
    r = c; g = x;
  } else if (hue < 120) {
    r = x; g = c;
  } else if (hue < 180) {
    g = c; b = x;
  } else if (hue < 240) {
    g = x; b = c;
  } else if (hue < 300) {
    r = x; b = c;
  } else {
    r = c; b = x;
  }
  const toHex = (value) => {
    const hex = Math.round((value + m) * 255).toString(16).padStart(2, "0");
    return hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Harmony rules selected deterministically by the seed.
export const HARMONY_RULES = ["analogous", "complementary", "triad"];

// ---- Palette from theme (kind: 'palette') ----------------------------------

// Deterministically generate a harmonious palette from a theme word/phrase.
// Returns an ai_generations-shaped record (input/output/kind/model/version/
// moderation_status) so it is sync-ready and consistently labeled AI-assisted.
export function generatePaletteFromTheme(theme) {
  const seed = hashString(theme || "happy paint");
  const rand = mulberry32(seed);
  const baseHue = seed % 360;
  const rule = HARMONY_RULES[seed % HARMONY_RULES.length];
  // Saturation/lightness band picked from the seed for variety but stable.
  const baseSat = 0.55 + (rand() * 0.3); // 0.55..0.85
  const colors = [];

  // A dark anchor + a light anchor frame every palette (good for line + paper).
  colors.push(hslToHex(baseHue, 0.35 + rand() * 0.2, 0.14)); // dark
  colors.push(hslToHex((baseHue + 30) % 360, 0.25, 0.95)); // light

  let hueOffsets;
  if (rule === "complementary") {
    hueOffsets = [0, 180, 30, 210, 60];
  } else if (rule === "triad") {
    hueOffsets = [0, 120, 240, 60, 180];
  } else {
    // analogous
    hueOffsets = [0, 30, -30, 60, -60];
  }

  for (let i = 0; i < hueOffsets.length; i += 1) {
    const lum = 0.42 + ((i % 3) * 0.12); // spread tones 0.42..0.66
    colors.push(hslToHex(baseHue + hueOffsets[i], baseSat, lum));
  }

  // De-dupe while preserving order; cap at 8 swatches.
  const seen = new Set();
  const palette = [];
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
    output: { colors: palette },
  };
}

// ---- Kid-safe prompt cards (kind: 'prompt_card') ---------------------------
// A curated, pre-approved local library (policy: never free-form open
// generation in kid_safe). Categories of safe, encouraging drawing prompts.

export const PROMPT_LIBRARY = [
  { category: "Animals", prompts: [
    "A cat astronaut floating among the stars",
    "A friendly dragon who loves to paint",
    "A penguin having a beach day",
    "A fox wearing a cozy scarf",
    "A whale carrying a tiny island on its back",
  ] },
  { category: "Places", prompts: [
    "A treehouse city in the clouds",
    "An underwater candy shop",
    "A cozy cabin in a glowing forest",
    "A neon arcade at midnight",
    "A floating market on rainbow boats",
  ] },
  { category: "Fantasy", prompts: [
    "A robot tending a garden of light bulbs",
    "A wizard's hat full of stars",
    "A door that opens to a different season",
    "A creature made of clouds and music",
    "A map to a place that doesn't exist yet",
  ] },
  { category: "Feelings", prompts: [
    "Draw what 'excited' looks like as a color burst",
    "A calm scene you'd want to nap in",
    "Your happiest place as a tiny world",
    "What 'curious' would look like as a creature",
    "A self-portrait as your favorite animal",
  ] },
];

// Deterministic-by-seed prompt pick (so a given seed reproduces). When no seed
// is given, derive one from the clock so "shuffle" feels fresh each tap.
export function shufflePrompt(seed) {
  const all = [];
  for (const group of PROMPT_LIBRARY) {
    for (const prompt of group.prompts) {
      all.push({ category: group.category, prompt });
    }
  }
  const s = typeof seed === "number" ? seed >>> 0 : (Date.now() >>> 0);
  const pick = all[s % all.length];
  return {
    kind: "prompt_card",
    model: LOCAL_MODEL,
    consent_version: AI_POLICY_VERSION,
    moderation_status: "pending",
    input: { seed: s, library: "curated_v1" },
    output: { category: pick.category, prompt: pick.prompt },
  };
}

// ---- Brush recipe from plain language (kind: 'brush_recipe') ---------------
// Maps phrases to existing Happy Paint brush parameters. Produces SETTINGS, not
// images (policy). Deterministic keyword matching — no model.

// Keyword -> partial brush settings. Matched substrings accumulate (later
// matches override) so "thick scratchy pencil" composes pencil + thick + scratchy.
const BRUSH_KEYWORDS = [
  // base brush types
  { match: ["pencil", "sketch"], settings: { brush: "pencil", size: 10, opacity: 0.6, variation: 0.18 } },
  { match: ["marker"], settings: { brush: "marker", size: 26, opacity: 0.9, variation: 0.05 } },
  { match: ["paint", "gouache", "acrylic"], settings: { brush: "paint", size: 40, opacity: 0.85, variation: 0.1 } },
  { match: ["spray", "airbrush", "air brush"], settings: { brush: "spray", size: 48, opacity: 0.5, variation: 0.2 } },
  { match: ["glow", "neon", "glitter", "gel pen", "gel"], settings: { brush: "glow", size: 22, opacity: 0.85, variation: 0.12 } },
  { match: ["eraser", "erase"], settings: { brush: "eraser", size: 30, opacity: 1, variation: 0 } },
  // modifiers
  { match: ["scratchy", "rough", "dry"], settings: { variation: 0.32, opacity: 0.55 } },
  { match: ["soft", "smooth", "gentle"], settings: { opacity: 0.6, variation: 0.04 } },
  { match: ["thick", "chunky", "bold", "heavy"], settings: { size: 64 } },
  { match: ["thin", "fine", "tiny", "small"], settings: { size: 6 } },
  { match: ["light", "faint", "pale"], settings: { opacity: 0.35 } },
  { match: ["solid", "opaque", "strong"], settings: { opacity: 1 } },
];

function clampSize(value) {
  return Math.min(120, Math.max(2, Math.round(value)));
}
function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

// Returns an ai_generations-shaped record whose `output` is a brush recipe.
// `output.brush_recipe` mirrors the typed space_assets.brush_recipe slot so a
// recipe can be saved to the locker by Brush Studio.
export function brushRecipeFromText(text) {
  const phrase = String(text || "").trim().toLowerCase();
  // Sensible defaults if nothing matches.
  let settings = { brush: "marker", size: 24, opacity: 0.86, variation: 0.08 };
  let matched = false;
  for (const entry of BRUSH_KEYWORDS) {
    if (entry.match.some((keyword) => phrase.includes(keyword))) {
      settings = { ...settings, ...entry.settings };
      matched = true;
    }
  }
  const recipe = {
    baseBrush: settings.brush,
    size: clampSize(settings.size),
    opacity: clampUnit(settings.opacity),
    variation: clampUnit(settings.variation),
  };
  return {
    kind: "brush_recipe",
    model: LOCAL_MODEL,
    consent_version: AI_POLICY_VERSION,
    moderation_status: "pending",
    input: { text: String(text || "").trim(), matched },
    output: { brush_recipe: recipe },
  };
}
