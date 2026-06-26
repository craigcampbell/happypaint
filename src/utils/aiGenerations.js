// AI generation moderation queue — LOCAL mirror of `ai_generations`.
//
// AI helpers in utils/aiAssist.js produce ai_generations-shaped records that
// carry `moderation_status: 'pending'`. Per docs/ai-policy.md §"Moderation of
// generated assets", any AI output that could become shareable/saved/packaged
// must pass moderation (pending -> approved | blocked) before it leaves the
// creating user's private space, and `moderation_status` is admin-set only.
//
// The studio currently applies generations in-memory rather than persisting an
// ai_generations row, so this module gives the admin queue something concrete:
// it persists generations a user chooses to save/share, seeds a couple of demo
// pending items so the queue is demonstrable, and lets a reviewer approve/block
// them with a moderation_actions-shaped audit row. Local-only, sync-ready shapes.

import { makeId } from "./paintSpace";

export const AI_GENERATIONS_STORAGE_KEY = "happypaint:ai-generations:v1";
export const AI_MOD_ACTIONS_STORAGE_KEY = "happypaint:ai-moderation-actions:v1";

function readStore(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Non-fatal: the queue still reflects in-memory for the session.
  }
}

// Demo pending generations so the AI review queue is never empty on a fresh
// device. Seeded once (keyed by id); a real decision on them persists.
const SEED_GENERATIONS = [
  {
    id: "aigen-seed-palette-aurora",
    profile_id: "seed-creator-aria",
    kind: "palette",
    model: null,
    consent_version: "2026-06-15",
    moderation_status: "pending",
    input: { theme: "aurora arcade", rule: "triad" },
    output: { colors: ["#0b1026", "#f4f7ff", "#5b8cff", "#a855f7", "#22d3ee"] },
    created_at: "2026-06-14T20:10:00.000Z",
  },
  {
    id: "aigen-seed-brush-chalk",
    profile_id: "seed-creator-milo",
    kind: "brush_recipe",
    model: null,
    consent_version: "2026-06-15",
    moderation_status: "pending",
    input: { text: "soft chalky pastel", matched: true },
    output: { brush_recipe: { baseBrush: "pencil", size: 18, opacity: 0.6, variation: 0.28 } },
    created_at: "2026-06-14T20:25:00.000Z",
  },
];

function ensureSeeded() {
  const stored = readStore(AI_GENERATIONS_STORAGE_KEY);
  if (stored.length > 0) {
    return stored;
  }
  writeStore(AI_GENERATIONS_STORAGE_KEY, SEED_GENERATIONS);
  return SEED_GENERATIONS;
}

export function readAiGenerations() {
  return readStore(AI_GENERATIONS_STORAGE_KEY);
}

// Persist a generation row (e.g. when a user saves/shares an AI output). New
// rows always enter as 'pending' — clients cannot self-approve (policy §72).
export function recordAiGeneration(generation) {
  const row = {
    id: makeId("aigen"),
    profile_id: "local-me",
    kind: generation.kind,
    model: generation.model ?? null,
    consent_version: generation.consent_version,
    moderation_status: "pending",
    input: generation.input || {},
    output: generation.output || {},
    created_at: new Date().toISOString(),
  };
  writeStore(AI_GENERATIONS_STORAGE_KEY, [row, ...readAiGenerations()]);
  return row;
}

// Pending generations for the admin queue (seeds demo items once). Newest-first.
export function getPendingAiGenerations() {
  return ensureSeeded().filter((row) => row.moderation_status === "pending");
}

export function readAiModerationActions() {
  return readStore(AI_MOD_ACTIONS_STORAGE_KEY);
}

function appendAction(generationId, decision, note) {
  const action = {
    id: makeId("aimodact"),
    actor_profile_id: "staff-local",
    action_type: decision === "approved" ? "approve_ai_generation" : "block_ai_generation",
    target_table: "ai_generations",
    target_id: generationId,
    note: note || null,
    created_at: new Date().toISOString(),
  };
  writeStore(AI_MOD_ACTIONS_STORAGE_KEY, [action, ...readAiModerationActions()]);
  return action;
}

// Review a generation. `decision` is 'approved' | 'blocked'. Updates the row's
// moderation_status and writes a moderation_actions-shaped audit row. Blocked
// rows are retained for audit but cannot be reused (policy §75).
export function reviewAiGeneration(generationId, decision, note = "") {
  const rows = readAiGenerations();
  const target = rows.find((row) => row.id === generationId);
  if (!target) {
    return null;
  }
  const next = { ...target, moderation_status: decision };
  writeStore(
    AI_GENERATIONS_STORAGE_KEY,
    rows.map((row) => (row.id === generationId ? next : row)),
  );
  appendAction(generationId, decision, note);
  return next;
}
