// Curated invitations, shared by the client and server. Association is not
// publication consent. Never scrape or automatically promote sensitive topics.
export const COMMUNITY_EVENTS = [
  {
    id: "draw-for-rhoam",
    title: "Draw for Rhoam",
    eyebrow: "A community tribute",
    description: "Make something kind in memory of Rhoam Summer. Draw quietly on your own, share a tribute if you choose, or create alongside friends.",
    prompt: "Draw a creature who needs understanding and friendship, or anything made with kindness.",
    detail: "Rhoam's parents asked people to draw and paint in his memory. This is an independent community response to that invitation, not an official family campaign. Every scribble is welcome; you do not have to publish it.",
    sourceUrl: "https://www.opb.org/article/2026/10/19/parents-of-rhoam-summer-share-memories-of-5-year-old-killed-in-bend-shooting/",
    sourceLabel: "Read the family's invitation, reported by OPB",
    sensitive: true,
    acceptsContributions: true,
    path: "/events/draw-for-rhoam",
    accent: "kindness",
  },
  {
    id: "inktober-2026",
    title: "Inktober 2026",
    eyebrow: "Daily drawing prompts",
    description: "Explore ink drawings, try a daily prompt, and make October's ideas your own. Draw one page or a whole sketchbook, at your own pace.",
    prompt: "Try an Inktober prompt in your own style.",
    detail: "Independent community participation, not affiliated with or endorsed by Inktober. Existing sketchbooks and shared Ink & Pencil rooms are still here.",
    sourceUrl: "https://inktober.com/rules",
    sourceLabel: "Official Inktober rules and prompts",
    sensitive: false,
    acceptsContributions: true,
    path: "/inktober",
    accent: "ink",
  },
  {
    id: "little-joys",
    title: "Little joys",
    eyebrow: "An anytime drawing invitation",
    description: "A warm drink, a funny pet, a tiny flower: draw one small thing that made your day brighter.",
    prompt: "Draw one small thing that made your day brighter.",
    detail: "A few lines are enough. Draw for yourself, invite a friend, or share a finished piece with the community when you are ready.",
    sourceUrl: null,
    sourceLabel: null,
    sensitive: false,
    acceptsContributions: true,
    path: "/events/little-joys",
    accent: "joy",
  },
];

export function getCommunityEvent(id) {
  return typeof id === "string" ? COMMUNITY_EVENTS.find((event) => event.id === id) || null : null;
}

export function eventDrawingPath(id) {
  const event = getCommunityEvent(id);
  return event ? `/draw?event=${encodeURIComponent(event.id)}` : "/draw";
}
