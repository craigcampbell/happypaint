import type { RoomAudience } from "./social";

export const DISCOVER_TAGS = [
  "Meme remix",
  "Anime",
  "Coloring",
  "Album cover",
  "Study break",
  "Cozy",
  "GIF frames",
  "Kid-safe",
  "Challenge"
];

export type DiscoveryRoom = {
  id: string;
  code: string;
  title: string;
  topic: string;
  audience: RoomAudience;
  status: string;
  tags: string[];
  artists: { active: number; max: number };
  viewers: { active: number; max: number };
  rolePolicy: string;
  accent: string;
};

export const DISCOVERABLE_ROOMS: DiscoveryRoom[] = [
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
    accent: "#0ea5e9"
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
    accent: "#ef4444"
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
    accent: "#10b981"
  }
];

export type TimedEvent = {
  id: string;
  title: string;
  theme: string;
  window: string;
  status: string;
  tags: string[];
  roomCount: number;
  galleryCount: number;
};

export const TIMED_EVENTS: TimedEvent[] = [
  {
    id: "event-daily-remix",
    title: "Daily Remix Drop",
    theme: "Turn a blank reaction card into today's mood.",
    window: "Ends in 5h",
    status: "Live",
    tags: ["Meme remix", "Kid-safe"],
    roomCount: 18,
    galleryCount: 64
  },
  {
    id: "event-weekend-wallpaper",
    title: "Weekend Wallpaper Jam",
    theme: "Make a phone wallpaper your group would actually use.",
    window: "Starts Friday",
    status: "Upcoming",
    tags: ["Cozy", "Challenge"],
    roomCount: 9,
    galleryCount: 21
  },
  {
    id: "event-loop-battle",
    title: "Loop Battle",
    theme: "Four frames, one vibe, no unsafe imports.",
    window: "Voting now",
    status: "Voting",
    tags: ["GIF frames", "Anime"],
    roomCount: 12,
    galleryCount: 37
  }
];

export type GalleryPiece = {
  id: string;
  title: string;
  roomTitle: string;
  event: string;
  contributors: number;
  votes: number;
  tags: string[];
  palette: string[];
};

export const PUBLIC_GALLERY_PIECES: GalleryPiece[] = [
  {
    id: "gallery-snack-planet",
    title: "Snack Planet",
    roomTitle: "Caption Chaos",
    event: "Daily Remix Drop",
    contributors: 4,
    votes: 482,
    tags: ["Meme remix", "Coloring"],
    palette: ["#f97316", "#22c55e", "#0f172a"]
  },
  {
    id: "gallery-night-loop",
    title: "Night Bus Loop",
    roomTitle: "Four Frame Loop Lab",
    event: "Loop Battle",
    contributors: 3,
    votes: 391,
    tags: ["GIF frames", "Anime"],
    palette: ["#38bdf8", "#a78bfa", "#111827"]
  },
  {
    id: "gallery-cover-static",
    title: "Static Hearts",
    roomTitle: "Fake Album Cover Night",
    event: "Weekend Wallpaper Jam",
    contributors: 6,
    votes: 274,
    tags: ["Album cover", "Study break"],
    palette: ["#ef4444", "#f8fafc", "#334155"]
  }
];
