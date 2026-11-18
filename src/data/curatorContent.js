// Shared, bounded Curator contract. Editorial content only; never HTML or CSS.
export const CURATOR_PAGES = Object.freeze({
  home: { path: '/', label: 'Homepage' },
  gallery: { path: '/gallery', label: 'Artwork gallery' },
  events: { path: '/events', label: 'Events index' },
  studios: { path: '/studios', label: 'Artist studios' },
});
export const CURATOR_PALETTES = ['paper', 'acid', 'vermilion'];
export const CURATOR_ART = ['ink', 'orbit', 'none'];
export const CURATOR_LINKS = ['/draw', '/gallery', '/events', '/studios', '/rooms', '/inktober', '/events/little-joys', '/events/draw-for-rhoam'];
const defaults = {
  home: { kicker: 'An open invitation to make something.', title: 'MAKE A\nBEAUTIFUL\nMESS.', description: 'A blank canvas. A wild idea. A little time to play.', note: 'no perfect lines required.', ctaLabel: 'Draw now', ctaHref: '/draw', palette: 'paper', art: 'ink' },
  gallery: { kicker: 'Made by people. Not a perfection contest.', title: 'THE ART\nIS THE POINT.', description: 'Explore drawings shared by the community.', note: 'look a little closer.', ctaLabel: 'Make your own', ctaHref: '/draw', palette: 'paper', art: 'orbit' },
  events: { kicker: 'A reason to pick up a brush.', title: 'GOOD IDEAS.\nOPEN INVITATIONS.', description: 'Find a shared idea. Draw your own contribution.', note: 'come as you are.', ctaLabel: 'Start drawing', ctaHref: '/draw', palette: 'paper', art: 'ink' },
  studios: { kicker: 'A window into somebody’s world.', title: 'ARTIST\nSTUDIOS.', description: 'Watch public studios. Drawing stays with the artist and approved painters.', note: 'watch first. join on your terms.', ctaLabel: 'Draw privately', ctaHref: '/draw', palette: 'paper', art: 'orbit' },
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
