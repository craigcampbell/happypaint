// Inktober 2026 — seasonal event state for the INKTOBER room + wall event.
//
// Independent fan participation: we use the official daily prompt list (owned
// by the parent in src/data/inktober2026.json, verified against
// https://inktober.com/rules) but claim no affiliation, logo, or endorsement.
//
// Everything is DERIVED from the UTC date (like the daily challenge): every
// server, restart and client agrees on the phase and the day's prompt with no
// stored state, and the rollover is a real UTC-midnight flip — never a RAM
// latch. The one shared INKTOBER mural is NEVER wiped by this: only the prompt
// rotates.
//
// Phases:
//   upcoming — before Oct 1: a warm-up prompt + banner, day is null (no false
//              day stamping), nextChangeAt is the Oct 1 UTC start.
//   active   — Oct 1..31: day = UTC day-of-month, prompt = the official list,
//              nextChangeAt = the next UTC midnight.
//   ended    — from Nov 1: day null, nextChangeAt null.
//
// Test hook: INKTOBER_CLOCK_FILE points at a file containing an ISO timestamp
// and is re-read on every evaluation (never set in production), so the
// isolated verify suite can walk the calendar and watch the live rollover.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const INKTOBER_ROOM = 'INKTOBER';

let raw = { year: 2026, source: 'https://inktober.com/rules', prompts: [] };
try {
  raw = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'data', 'inktober2026.json'), 'utf8'));
} catch {
  // Missing list degrades to an empty prompt table — the room still runs.
}

export const INKTOBER_YEAR = Number(raw.year) || 2026;
export const INKTOBER_SOURCE = typeof raw.source === 'string' && raw.source
  ? raw.source : 'https://inktober.com/rules';
export const INKTOBER_EVENT = `inktober-${INKTOBER_YEAR}`;

const PROMPTS = (Array.isArray(raw.prompts) ? raw.prompts : [])
  .map((p) => ({ day: Number(p.day), date: String(p.date || ''), prompt: String(p.prompt || '') }))
  .filter((p) => Number.isInteger(p.day) && p.day >= 1 && p.day <= 31
    && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.prompt.length > 0)
  .sort((a, b) => a.day - b.day);

// Kid-safe, no brand assets, no date claims beyond the real calendar.
const WARMUP_PROMPT = 'Warm up your pen — Inktober starts October 1!';
const ENDED_PROMPT = 'Inktober has wrapped for this year — thanks for inking with us!';

function nowMs() {
  const file = process.env.INKTOBER_CLOCK_FILE;
  if (file) {
    try {
      const t = Date.parse(readFileSync(file, 'utf8').trim());
      if (Number.isFinite(t)) return t;
    } catch { /* fall through to the real clock */ }
  }
  return Date.now();
}

// The full event state, identical for /api/inktober, the WS handshake `event`,
// the seasonal_prompt broadcast and the wall-post stamping.
export function inktoberState(atMs = null) {
  const now = new Date(atMs != null ? atMs : nowMs());
  const date = now.toISOString().slice(0, 10);
  const start = Date.UTC(INKTOBER_YEAR, 9, 1); // Oct 1 00:00Z
  const end = Date.UTC(INKTOBER_YEAR, 10, 1); // Nov 1 00:00Z
  const t = now.getTime();
  const base = {
    year: INKTOBER_YEAR,
    date,
    source: INKTOBER_SOURCE,
    prompts: PROMPTS,
    room: INKTOBER_ROOM,
  };
  if (t < start) {
    return { ...base, phase: 'upcoming', day: null, prompt: WARMUP_PROMPT, nextChangeAt: new Date(start).toISOString() };
  }
  if (t >= end) {
    return { ...base, phase: 'ended', day: null, prompt: ENDED_PROMPT, nextChangeAt: null };
  }
  const day = now.getUTCDate();
  const entry = PROMPTS.find((p) => p.day === day);
  return {
    ...base,
    phase: 'active',
    day,
    prompt: entry ? entry.prompt : `Day ${day}`,
    nextChangeAt: new Date(Date.UTC(INKTOBER_YEAR, 9, day + 1)).toISOString(),
  };
}

// ---- Ink & pencil room guard -------------------------------------------------
// The INKTOBER room is ink + pencil only (eraser permitted — the contract's
// "tool draw eraser settings"). Brushes are identified by the op's settings,
// which ride every batch. V3 strokes carry their own inline dab descriptor:
// legitimate ink/pencil strokes use the native shapes below, so inline dabs
// are NOT blanket-rejected — but a dab that describes a DIFFERENT brush
// (a watercolor wash, a glow, an imported stamp tip) is a forged bypass and
// is refused.
export const INK_BRUSHES = new Set(['ink', 'pencil', 'eraser']);

// Native dab shapes per brush, matching src/utils/brushes.js: ink is the crisp
// round disc (v2 catalog, and v2 ink ops carry no inline dab at all); pencil's
// v3 NATURAL_DABS shape is "graphite" ("pencil" is its v2 catalog shape).
const INK_DAB_SHAPES = {
  ink: new Set(['round']),
  pencil: new Set(['graphite', 'pencil']),
};

export function inkDrawSettingsAllowed(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const brush = typeof settings.brush === 'string' ? settings.brush : '';
  if (!INK_BRUSHES.has(brush)) return false;
  if (brush === 'eraser') return true; // eraser has no dab — allowed by contract
  const dab = settings.dab;
  if (dab == null) return true; // v2 / legacy stroke: brush id is the contract
  if (typeof dab !== 'object' || Array.isArray(dab)) return false;
  if (dab.stampDataUrl != null) return false; // imported stamp tips are user media
  return INK_DAB_SHAPES[brush].has(dab.shape);
}
