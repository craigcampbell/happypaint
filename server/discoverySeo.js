import { COMMUNITY_EVENTS } from '../src/data/communityEvents.js';
import { getDiscoverySeo } from '../src/data/discoverySeo.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// Real initial document content for every visitor, replaced by the interactive
// React view on mount. No bot-specific rendering or private room lookups.
export function renderDiscoveryLanding(rawPath, posts = []) {
  const meta = getDiscoverySeo(rawPath);
  if (!meta) return '';
  const event = COMMUNITY_EVENTS.find((item) => item.path === meta.path);
  const art = posts.filter((post) => !post.hidden && !post.unpublished && /^wp_[a-zA-Z0-9_-]+$/.test(post.id) && (!event || post.event === event.id)).slice(0, 12);
  const links = '<nav aria-label="Discover Drawesome"><a href="/">Drawesome</a> · <a href="/gallery">Artwork</a> · <a href="/studios">Artist studios</a> · <a href="/events">Drawing events</a> · <a href="/rooms">Drawing rooms</a></nav>';
  const invitation = event
    ? `<p>${escape(event.detail)}</p>${event.sourceUrl ? `<p><a href="${escape(event.sourceUrl)}" rel="noopener noreferrer">${escape(event.sourceLabel)}</a></p>` : ''}<p><a href="/draw?event=${escape(event.id)}">Draw my own</a> · <a href="/studios?event=${escape(event.id)}">Watch participating studios</a></p>`
    : '<p>Free online drawing, coloring pages, shared canvases and drawing games. Draw anonymously, or watch a public studio before joining. Public viewing does not give permission to paint.</p><p><a href="/draw">Start your own drawing</a> · <a href="/join/MAIN">Join the shared Open Studio</a></p>';
  const invitations = !event && meta.path !== '/draw' ? `<section><h2>Community drawing invitations</h2><ul>${COMMUNITY_EVENTS.map((item) => `<li><a href="${escape(item.path)}">${escape(item.title)}</a><p>${escape(item.description)}</p></li>`).join('')}</ul></section>` : '';
  const gallery = art.length ? `<section><h2>Community artwork</h2>${art.map((post) => `<figure><a href="/wall/${escape(post.id)}"><img src="/api/wall/${escape(post.id)}/frame/0" alt="${escape(post.title)}" width="400" height="250" loading="lazy"><figcaption>${escape(post.title)} — ${escape(post.artist)}</figcaption></a></figure>`).join('')}</section>` : '';
  return `<main class="route-status" data-discovery-landing>${links}<h1>${escape(meta.heading)}</h1><p>${escape(meta.description)}</p>${invitation}${invitations}${gallery}<p><a href="/wall">The Fridge Wall</a> · <a href="/inktober">Inktober</a> · <a href="/parents">Parents and teachers</a> · <a href="/safety">Safety</a> · <a href="/privacy">Privacy</a></p><noscript>Turn on JavaScript to use the drawing canvas and interactive galleries.</noscript></main>`;
}
