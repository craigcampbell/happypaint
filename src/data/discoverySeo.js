import { COMMUNITY_EVENTS } from './communityEvents.js';
import { LEGACY_PAGE_META } from './legacyPageMeta.js';

// Existing landing URLs remain canonical. Additive only: /wall, /rooms,
// /inktober and every old sitemap entry retain their addresses.
const PAGES = {
  '/': {
    title: 'Drawesome: Free Online Drawing, Doodling & Art Community',
    description: 'Draw online for free, discover community artwork, and watch artists create. Try drawing prompts, make your own doodle, or draw together. No account needed to draw.',
    heading: 'Draw online. Find inspiration. Make it your own.',
  },
  '/gallery': {
    title: 'Community Art Gallery: Drawings & Doodles | Drawesome',
    description: 'Explore drawings, doodles and public sketchbooks made on Drawesome. Find inspiration, discover artists, and join community drawing events for free.',
    heading: 'Discover what people are making',
  },
  '/studios': {
    title: 'Artist Studios: Watch & Draw Together | Drawesome',
    description: 'Discover public drawing studios. Watch artists create, or open your own studio where only you and approved collaborators can draw.',
    heading: 'Watch artists. Draw on your terms.',
  },
  '/events': {
    title: 'Community Drawing Events & Art Prompts | Drawesome',
    description: 'Find a reason to draw. Explore community art invitations and drawing prompts, make your own contribution privately, and share only when you choose.',
    heading: 'Find a reason to draw',
  },
  '/draw': {
    title: 'Free Online Drawing Canvas: Draw Your Own | Drawesome',
    description: 'Start a private, browser-local drawing without an account. Doodle, sketch and paint with free drawing tools. Only share your artwork when you choose.',
    heading: 'Your canvas. Your pace.',
  },
  '/inktober': {
    title: 'Inktober 2026: Drawing Prompts & Community Art | Drawesome',
    description: 'Explore Inktober drawings and public sketchbooks, try the daily ink prompt, or draw together. Free independent community participation on Drawesome.',
    heading: 'Inktober at Drawesome',
  },
};

export const DISCOVERY_PATHS = ['/gallery', '/studios', '/events', '/draw', ...COMMUNITY_EVENTS.filter((event) => event.path.startsWith('/events/')).map((event) => event.path)];

export function getPageSeo(rawPath) {
  const path = String(rawPath).split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const discovery = getDiscoverySeo(path);
  if (discovery) return discovery;
  if (LEGACY_PAGE_META[path]) return { ...LEGACY_PAGE_META[path], path };
  return null;
}

export function getDiscoverySeo(rawPath) {
  const path = String(rawPath).split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const event = COMMUNITY_EVENTS.find((item) => item.path === path);
  const page = PAGES[path] || (event ? {
    title: `${event.title}: Community Art Invitation | Drawesome`,
    description: event.description,
    heading: event.title,
  } : null);
  return page ? { ...page, path } : null;
}
