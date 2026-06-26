// Event Engine — the recurring-event loop (daily prompt, weekend challenge,
// voting window, gallery winner) for the Discovery surface.
//
// MOCK / LOCAL ONLY. No backend, no network. The shapes here deliberately mirror
// the backend tables so this is sync-ready (and mirror the web build's
// src/utils/eventEngine.js for cross-platform consistency):
//   - timed_events       (id, title, theme, description, tags, audience, status,
//                          starts_at, ends_at, voting_starts_at, voting_ends_at)
//                          status lifecycle: draft -> upcoming -> live -> voting -> ended
//   - gallery_posts      (id, event_id, title, image/thumbnail, tags, votes_count,
//                          status, visibility) — used as the votable event entries
//   - event_entries      (event_id, gallery_post_id) — links posts to an event
//   - gallery_votes      (post_id, profile_id, value=1) — ONE vote per profile per
//                          post (anti-brigading; enforced in the mock helpers)
//
// Audience gating: only kid-safe / friends events are surfaced on the discovery
// surface. adult-18 events are never shown (per docs + schema check
// `audience <> 'adult_18' or status in ('draft','cancelled')`).

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { RoomAudience } from "./social";

// One vote per profile needs a subject without auth: a stable per-device pseudo
// profile id (mirrors gallery_votes.profile_id). Persisted via AsyncStorage.
const VOTE_PROFILE_KEY = "happy-paint:event-profile:v1";
const VOTES_STORAGE_KEY = "happy-paint:event-votes:v1";

export async function getVoteProfileId(): Promise<string> {
  try {
    let id = await AsyncStorage.getItem(VOTE_PROFILE_KEY);
    if (!id) {
      id = `profile-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      await AsyncStorage.setItem(VOTE_PROFILE_KEY, id);
    }
    return id;
  } catch {
    return "profile-anon";
  }
}

// The set of post ids this profile has voted for (mirrors the (post_id,
// profile_id) primary key in gallery_votes — locally we only need the post ids).
export async function readVotedPostIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(VOTES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export async function writeVotedPostIds(ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(VOTES_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Non-fatal: voting still reflects in-memory for the session.
  }
}

// ---- Types (mirror the backend tables) ----
export type TimedEventStatus = "draft" | "upcoming" | "live" | "voting" | "ended" | "cancelled";

export type EventAudience = RoomAudience; // "kid-safe" | "friends" | "adult-18"

export type GalleryPost = {
  id: string;
  event_id: string;
  title: string;
  roomTitle: string;
  contributors: number;
  tags: string[];
  palette: string[];
  votes_count: number;
  status: "approved" | "pending";
  visibility: "public" | "friends";
};

export type EventEntry = GalleryPost & {
  voted: boolean;
  displayVotes: number;
};

export type EventRecord = {
  id: string;
  title: string;
  theme: string;
  description: string;
  tags: string[];
  audience: EventAudience;
  prompt: string;
  starts_at: number;
  ends_at: number;
  voting_starts_at: number | null;
  voting_ends_at: number | null;
  roomCount: number;
  entryPostIds: string[];
};

export type SurfaceEvent = EventRecord & { status: TimedEventStatus };

export type PromptPack = {
  id: string;
  kind: "daily" | "weekend";
  title: string;
  cadence: string;
  prompts: string[];
};

// ---- Mock data (windows relative to now so the countdown is always live) ----
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const now = () => Date.now();

// Curated local prompt packs (no internet imports) for the Daily Prompt + Weekend
// Challenge cards.
export const PROMPT_PACKS: PromptPack[] = [
  {
    id: "pack-daily",
    kind: "daily",
    title: "Daily Prompt",
    cadence: "New prompt every day",
    prompts: [
      "Draw your mood as a tiny weather system.",
      "A snack that became a superhero.",
      "Your room if it floated in space.",
      "A pet that runs a small business.",
      "The album cover for today's vibe."
    ]
  },
  {
    id: "pack-weekend",
    kind: "weekend",
    title: "Weekend Challenge",
    cadence: "One big theme each weekend",
    prompts: [
      "Design a phone wallpaper your group would actually use.",
      "A four-frame loop of something looping forever.",
      "A cozy scene with exactly three colors."
    ]
  }
];

// A stable "prompt of the day" from a pack without randomness drift.
export function promptOfTheDay(pack: PromptPack): string {
  if (!pack?.prompts?.length) {
    return "";
  }
  const dayIndex = Math.floor(now() / DAY);
  return pack.prompts[dayIndex % pack.prompts.length];
}

// gallery_posts that act as votable event entries. votes_count is the seeded base
// count; the live UI adds the viewer's own vote on top.
const GALLERY_POSTS: GalleryPost[] = [
  {
    id: "post-snack-planet",
    event_id: "event-daily-remix",
    title: "Snack Planet",
    roomTitle: "Caption Chaos",
    contributors: 4,
    tags: ["Meme remix", "Coloring"],
    palette: ["#f97316", "#22c55e", "#0f172a"],
    votes_count: 482,
    status: "approved",
    visibility: "public"
  },
  {
    id: "post-night-loop",
    event_id: "event-loop-battle",
    title: "Night Bus Loop",
    roomTitle: "Four Frame Loop Lab",
    contributors: 3,
    tags: ["GIF frames", "Anime"],
    palette: ["#38bdf8", "#a78bfa", "#111827"],
    votes_count: 391,
    status: "approved",
    visibility: "public"
  },
  {
    id: "post-static-hearts",
    event_id: "event-loop-battle",
    title: "Static Hearts",
    roomTitle: "Loop Lab Friends",
    contributors: 5,
    tags: ["Album cover", "Study break"],
    palette: ["#ef4444", "#f8fafc", "#334155"],
    votes_count: 274,
    status: "approved",
    visibility: "public"
  },
  {
    id: "post-dream-bus",
    event_id: "event-weekend-wallpaper",
    title: "Dream Bus Window",
    roomTitle: "Wallpaper Jam",
    contributors: 2,
    tags: ["Cozy", "Challenge"],
    palette: ["#0ea5e9", "#fde68a", "#1e293b"],
    votes_count: 198,
    status: "approved",
    visibility: "public"
  }
];

// timed_events. event_entries are modeled inline as `entryPostIds` (the
// gallery_post ids linked to the event) so the mock stays a single object graph.
const BASE_EVENTS: EventRecord[] = [
  {
    id: "event-daily-remix",
    title: "Daily Remix Drop",
    theme: "Turn a blank reaction card into today's mood.",
    description: "Library prompts only. No imported memes — start from a blank card.",
    tags: ["Meme remix", "Kid-safe"],
    audience: "kid-safe",
    prompt: "Turn a blank reaction card into today's mood.",
    starts_at: now() - 2 * HOUR,
    ends_at: now() + 5 * HOUR,
    voting_starts_at: now() + 5 * HOUR,
    voting_ends_at: now() + 5 * HOUR + DAY,
    roomCount: 18,
    entryPostIds: []
  },
  {
    id: "event-weekend-wallpaper",
    title: "Weekend Wallpaper Jam",
    theme: "Make a phone wallpaper your group would actually use.",
    description: "Cozy, screen-ready art. Friends rooms can remix together.",
    tags: ["Cozy", "Challenge"],
    audience: "friends",
    prompt: "Make a phone wallpaper your group would actually use.",
    starts_at: now() + 2 * DAY,
    ends_at: now() + 4 * DAY,
    voting_starts_at: now() + 4 * DAY,
    voting_ends_at: now() + 5 * DAY,
    roomCount: 9,
    entryPostIds: ["post-dream-bus"]
  },
  {
    id: "event-loop-battle",
    title: "Loop Battle",
    theme: "Four frames, one vibe, no unsafe imports.",
    description: "Tiny animation loops. Vote for the best loop while voting is open.",
    tags: ["GIF frames", "Anime"],
    audience: "kid-safe",
    prompt: "Four frames, one vibe, no unsafe imports.",
    starts_at: now() - 3 * DAY,
    ends_at: now() - 2 * HOUR,
    voting_starts_at: now() - 2 * HOUR,
    voting_ends_at: now() + 6 * HOUR,
    roomCount: 12,
    entryPostIds: ["post-night-loop", "post-static-hearts"]
  },
  {
    id: "event-color-pass",
    title: "Color Pass Cup",
    theme: "Best color pass on a shared line drawing.",
    description: "Ended event — winner shown. Library palettes only.",
    tags: ["Coloring", "Kid-safe"],
    audience: "kid-safe",
    prompt: "Best color pass on a shared line drawing.",
    starts_at: now() - 6 * DAY,
    ends_at: now() - 4 * DAY,
    voting_starts_at: now() - 4 * DAY,
    voting_ends_at: now() - 1 * DAY,
    roomCount: 7,
    entryPostIds: ["post-snack-planet"]
  },
  // Adult event — must NEVER appear on the default discovery surface.
  {
    id: "event-adult-hidden",
    title: "Late Night Adult Jam",
    theme: "Hidden from child + default discovery surfaces.",
    description: "Adult-only; gated behind verification.",
    tags: ["18+"],
    audience: "adult-18",
    prompt: "",
    starts_at: now() - 1 * HOUR,
    ends_at: now() + 4 * HOUR,
    voting_starts_at: null,
    voting_ends_at: null,
    roomCount: 1,
    entryPostIds: []
  }
];

// Derive the lifecycle status from the time windows so it always matches the
// countdown (mirrors timed_event_status: upcoming/live/voting/ended).
export function deriveStatus(event: EventRecord, atMs: number = now()): TimedEventStatus {
  if (atMs < event.starts_at) {
    return "upcoming";
  }
  if (atMs < event.ends_at) {
    return "live";
  }
  if (event.voting_ends_at && atMs < event.voting_ends_at) {
    return "voting";
  }
  return "ended";
}

// The next phase boundary + a label, used to render a countdown.
export function nextPhase(event: EventRecord, atMs: number = now()): { label: string; at: number | null } {
  const status = deriveStatus(event, atMs);
  switch (status) {
    case "upcoming":
      return { label: "Starts in", at: event.starts_at };
    case "live":
      return { label: "Drawing ends in", at: event.ends_at };
    case "voting":
      return { label: "Voting ends in", at: event.voting_ends_at };
    default:
      return { label: "Ended", at: null };
  }
}

// Human countdown string from a target timestamp.
export function formatCountdown(targetMs: number | null, atMs: number = now()): string {
  if (!targetMs) {
    return "";
  }
  let diff = Math.max(0, targetMs - atMs);
  const days = Math.floor(diff / DAY);
  diff -= days * DAY;
  const hours = Math.floor(diff / HOUR);
  diff -= hours * HOUR;
  const minutes = Math.floor(diff / (60 * 1000));
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Default-surface events: kid-safe + friends only, never adult, sorted by phase
// (live first, then voting, upcoming, ended). Each carries its derived status.
export function getSurfaceEvents(atMs: number = now()): SurfaceEvent[] {
  const order: Record<TimedEventStatus, number> = {
    live: 0,
    voting: 1,
    upcoming: 2,
    ended: 3,
    draft: 4,
    cancelled: 5
  };
  return BASE_EVENTS.filter((event) => event.audience === "kid-safe" || event.audience === "friends")
    .map((event) => ({ ...event, status: deriveStatus(event, atMs) }))
    .sort((a, b) => order[a.status] - order[b.status]);
}

// The gallery_posts (votable entries) for an event, highest votes first. The
// `votedPostIds` set marks which the current profile already voted for, and adds
// that +1 to the displayed count so the UI reflects the vote optimistically.
export function getEventEntries(eventId: string, votedPostIds: string[] = []): EventEntry[] {
  const event = BASE_EVENTS.find((item) => item.id === eventId);
  if (!event) {
    return [];
  }
  return event.entryPostIds
    .map((postId) => GALLERY_POSTS.find((post) => post.id === postId))
    .filter((post): post is GalleryPost => Boolean(post))
    .map((post) => {
      const voted = votedPostIds.includes(post.id);
      return { ...post, voted, displayVotes: post.votes_count + (voted ? 1 : 0) };
    })
    .sort((a, b) => b.displayVotes - a.displayVotes);
}

// The winning entry for an ended event (highest votes). Returns null if none.
export function getWinner(eventId: string, votedPostIds: string[] = []): EventEntry | null {
  const entries = getEventEntries(eventId, votedPostIds);
  return entries.length > 0 ? entries[0] : null;
}

export type CastVoteResult = { ok: boolean; reason?: "already-voted"; votedPostIds: string[] };

// Record one vote for a post by the current profile. Enforces
// one-vote-per-profile-per-post (anti-brigading). Mirrors a gallery_votes insert
// with value=1 and the (post_id, profile_id) unique key.
export async function castVote(postId: string): Promise<CastVoteResult> {
  const voted = await readVotedPostIds();
  if (voted.includes(postId)) {
    return { ok: false, reason: "already-voted", votedPostIds: voted };
  }
  const next = [...voted, postId];
  await writeVotedPostIds(next);
  // A real backend also inserts a gallery_vote row and increments
  // gallery_posts.votes_count; locally the display count derives the +1.
  return { ok: true, votedPostIds: next };
}
