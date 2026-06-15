const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const SOCIAL_STORAGE_KEYS = {
  sessions: "happypaint:social-sessions:v1",
  profile: "happypaint:social-profile:v1",
};

export const kidSafetyPrinciples = [
  "No public people search.",
  "Invite links and room codes first.",
  "Kid-safe rooms use approved Happy Paint library media before internet imports.",
  "Email and phone are optional account recovery or parent-approved contact methods.",
  "Anyone under 13 should use a guardian-managed account before contacts, chat, or friend lists.",
];

export const roomAudiencePolicies = [
  {
    id: "kid-safe",
    title: "Kid-safe",
    label: "Curated library only",
    detail: "Only Happy Paint library prompts, stickers, and templates. Unknown links and uploads stay off.",
  },
  {
    id: "friends",
    title: "Friends",
    label: "Invite-only remix",
    detail: "Friends can add art, images, and links after moderation checks are connected.",
  },
  {
    id: "adult-18",
    title: "18+",
    label: "Verified adults only",
    detail: "Hidden from child accounts and blocked until adult verification exists on the backend.",
  },
];

export const safeMediaLibrary = [
  {
    id: "meme-captions",
    title: "Caption Cards",
    type: "Prompt pack",
    detail: "Blank reaction cards and speech bubbles with no imported meme source needed.",
  },
  {
    id: "friendly-stickers",
    title: "Friendly Stickers",
    type: "Sticker pack",
    detail: "Stars, arrows, badges, sparkle marks, and cozy reaction stamps.",
  },
  {
    id: "color-challenges",
    title: "Color Challenges",
    type: "Drawing prompt",
    detail: "Safe daily prompts like dream room, snack mascot, album cover, and space pet.",
  },
];

export const discoverTags = [
  "Meme remix",
  "Anime",
  "Coloring",
  "Album cover",
  "Study break",
  "Cozy",
  "GIF frames",
  "Kid-safe",
  "Challenge",
];

export const discoverableRooms = [
  {
    id: "room-caption-chaos",
    code: "CAPTION",
    title: "Caption Chaos",
    topic: "Draw the reaction image, not the comment section.",
    audience: "kid-safe",
    status: "Live preview",
    tags: ["Meme remix", "Kid-safe", "Coloring"],
    artists: { active: 3, max: 5 },
    viewers: { active: 28, max: 80 },
    rolePolicy: "Host approves artist seats. Viewers can watch, vote, and react.",
    accent: "#0ea5e9",
  },
  {
    id: "room-album-cover",
    code: "COVER9",
    title: "Fake Album Cover Night",
    topic: "Make a cover for a song that does not exist yet.",
    audience: "friends",
    status: "Starts soon",
    tags: ["Album cover", "Study break", "Challenge"],
    artists: { active: 2, max: 6 },
    viewers: { active: 15, max: 60 },
    rolePolicy: "Invited friends can request artist or viewer role before the room opens.",
    accent: "#ef4444",
  },
  {
    id: "room-gif-loop",
    code: "LOOP44",
    title: "Four Frame Loop Lab",
    topic: "Tiny animated GIF prompts with safe frame templates.",
    audience: "kid-safe",
    status: "Featured",
    tags: ["GIF frames", "Kid-safe", "Anime"],
    artists: { active: 4, max: 4 },
    viewers: { active: 42, max: 100 },
    rolePolicy: "Artist seats are full. Viewers can preview and follow the finished gallery post.",
    accent: "#10b981",
  },
];

export const timedEvents = [
  {
    id: "event-daily-remix",
    title: "Daily Remix Drop",
    theme: "Turn a blank reaction card into today's mood.",
    window: "Ends in 5h",
    status: "Live",
    tags: ["Meme remix", "Kid-safe"],
    roomCount: 18,
    galleryCount: 64,
  },
  {
    id: "event-weekend-wallpaper",
    title: "Weekend Wallpaper Jam",
    theme: "Make a phone wallpaper your group would actually use.",
    window: "Starts Friday",
    status: "Upcoming",
    tags: ["Cozy", "Challenge"],
    roomCount: 9,
    galleryCount: 21,
  },
  {
    id: "event-loop-battle",
    title: "Loop Battle",
    theme: "Four frames, one vibe, no unsafe imports.",
    window: "Voting now",
    status: "Voting",
    tags: ["GIF frames", "Anime"],
    roomCount: 12,
    galleryCount: 37,
  },
];

export const publicGalleryPieces = [
  {
    id: "gallery-snack-planet",
    title: "Snack Planet",
    roomTitle: "Caption Chaos",
    event: "Daily Remix Drop",
    contributors: 4,
    votes: 482,
    tags: ["Meme remix", "Coloring"],
    palette: ["#f97316", "#22c55e", "#0f172a"],
  },
  {
    id: "gallery-night-loop",
    title: "Night Bus Loop",
    roomTitle: "Four Frame Loop Lab",
    event: "Loop Battle",
    contributors: 3,
    votes: 391,
    tags: ["GIF frames", "Anime"],
    palette: ["#38bdf8", "#a78bfa", "#111827"],
  },
  {
    id: "gallery-cover-static",
    title: "Static Hearts",
    roomTitle: "Fake Album Cover Night",
    event: "Weekend Wallpaper Jam",
    contributors: 6,
    votes: 274,
    tags: ["Album cover", "Study break"],
    palette: ["#ef4444", "#f8fafc", "#334155"],
  },
];

export const revenueModels = [
  {
    id: "drops-wallet",
    title: "Drops Wallet",
    price: "80 Drops from $0.99",
    detail: "Buy optional Drops for tips, official packs, room themes, export tokens, and extra storage.",
  },
  {
    id: "creator-tips",
    title: "Tips and Kudos",
    price: "10-100 Drop tips",
    detail: "Support gallery posts, community packs, event winners, and room hosts without buying votes.",
  },
  {
    id: "creator-market",
    title: "Creator Packs",
    price: "Drops per pack",
    detail: "Moderated brushes, stamps, templates, tiny loops, coloring pages, and safe event bundles.",
  },
];

export function roomPolicyFor(audienceId) {
  return roomAudiencePolicies.find((policy) => policy.id === audienceId) || roomAudiencePolicies[0];
}

export function createInviteCode(length = 6) {
  let code = "";

  for (let index = 0; index < length; index += 1) {
    code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }

  return code;
}

export function normalizeInviteCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export function createInviteLink(code) {
  const origin = window.location.origin;
  return `${origin}/join/${encodeURIComponent(code)}`;
}

export function readSocialSessions() {
  try {
    return JSON.parse(window.localStorage.getItem(SOCIAL_STORAGE_KEYS.sessions) || "[]").map((session) => ({
      audience: "kid-safe",
      ...session,
    }));
  } catch {
    return [];
  }
}

export function writeSocialSessions(sessions) {
  try {
    window.localStorage.setItem(SOCIAL_STORAGE_KEYS.sessions, JSON.stringify(sessions));
  } catch {
    // Social planning can still work in-memory when storage is unavailable.
  }
}

export async function shareInvite({ code, title = "Happy Paint session" }) {
  const url = createInviteLink(code);
  const text = `Join my Happy Paint room with code ${code}`;

  if (navigator.share) {
    await navigator.share({ title, text, url });
    return "Shared invite";
  }

  await navigator.clipboard?.writeText(`${text}\n${url}`);
  return "Invite copied";
}
