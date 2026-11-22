// Shared, bounded Curator contract. Editorial content only; never HTML or CSS.
export const CURATOR_PAGES = Object.freeze({
  home: { path: '/', label: 'Homepage' },
  gallery: { path: '/gallery', label: 'Artwork gallery' },
  events: { path: '/events', label: 'Events index' },
  studios: { path: '/studios', label: 'Artist studios' },
});
export const CURATOR_PALETTES = ['paper', 'acid', 'vermilion'];
export const CURATOR_ART = ['ink', 'orbit', 'none'];
export const QUICK_JOIN_PATH = '/api/rooms/quick-join';
export const CURATOR_LINKS = [QUICK_JOIN_PATH, '/wall', '/draw', '/gallery', '/events', '/studios', '/rooms', '/inktober', '/events/little-joys', '/events/draw-for-rhoam'];
const defaults = {
  home: { kicker: 'Multiplayer drawing', title: 'Come draw\nwith us.', description: 'Join a public Art Jam to draw with someone new, or share a private canvas with friends and family.', note: 'Free to join · Ad-supported rooms', ctaLabel: 'Join an Art Jam', ctaHref: QUICK_JOIN_PATH, palette: 'acid', art: 'ink' },
  gallery: { kicker: '', title: 'Community\ngallery.', description: 'Browse finished drawings, look up an artist, or open a sketchbook to see how an idea developed.', note: '', ctaLabel: 'Open the Fridge Wall', ctaHref: '/wall', palette: 'paper', art: 'orbit' },
  events: { kicker: '', title: 'Drawing\ninvitations.', description: 'Choose a community prompt. Each invitation opens its own drawing activity and explains how to share your contribution.', note: '', ctaLabel: 'Explore Inktober', ctaHref: '/inktober', palette: 'paper', art: 'ink' },
  studios: { kicker: '', title: 'Artist\nstudios.', description: 'Pick a public studio to watch its canvas as it changes. The artist chooses who can join them to paint.', note: '', ctaLabel: 'Find a shared canvas', ctaHref: '/rooms', palette: 'paper', art: 'orbit' },
};
export function getCuratorDefaults(page) { return Object.hasOwn(defaults, page) ? { ...defaults[page] } : null; }
export function curatorPageForPath(path) { return Object.keys(CURATOR_PAGES).find((key) => CURATOR_PAGES[key].path === path) || null; }
export function validateCuratorContent(page, raw) {
  if (!Object.hasOwn(CURATOR_PAGES, page) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_page_or_content' };
  const limits = { kicker: 90, title: 120, description: 280, note: 80, ctaLabel: 36, ctaHref: 80, palette: 16, art: 16 };
  if (Object.keys(raw).some((key) => !Object.hasOwn(limits, key))) return { ok: false, error: 'unknown_field' };
  const content = {};
  for (const [key, max] of Object.entries(limits)) {
    if (typeof raw[key] !== 'string' || raw[key].length > max || [...raw[key]].some((char) => { const code = char.charCodeAt(0); return code < 9 || (code > 10 && code < 32) || code === 127; })) return { ok: false, error: `invalid_${key}` };
    content[key] = raw[key].trim();
  }
  if (!content.title || !content.ctaLabel || content.title.split('\n').length > 3 || content.title.split('\n').some((line) => line.length > 40)) return { ok: false, error: 'invalid_title_or_label' };
  if (!CURATOR_LINKS.includes(content.ctaHref) || !CURATOR_PALETTES.includes(content.palette) || !CURATOR_ART.includes(content.art)) return { ok: false, error: 'invalid_choice' };
  return { ok: true, content };
}
