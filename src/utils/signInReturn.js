import { getCommunityEvent } from '../data/communityEvents.js';

// A closed internal-destination allowlist, not an arbitrary URL redirect.
export function safeSignInReturn(requested) {
  if (typeof requested !== 'string') return '';
  if (/^\/(family|jam-pass|coloring-book|friends|rooms|join\/[A-Z0-9]{1,8}(?:\?color=1)?|sketchbook(?:\/(?:invite\/[A-Za-z0-9_-]{1,96}|sb_[a-f0-9]{16}))?)$/.test(requested)) return requested;
  if (requested.startsWith('/draw?')) {
    if (requested.includes('#') || requested.length > 2400) return '';
    const entries = [...new URLSearchParams(requested.slice('/draw?'.length))];
    if (entries.length !== 1) return '';
    const [[key, value]] = entries;
    if (key === 'idea' && /^(?:ink-cat|record-monster|sky-fish|idea-[1-8])$/.test(value)) return `/draw?idea=${value}`;
    if (key === 'prompt' && value.trim() && value.length <= 180 &&
        ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      return `/draw?prompt=${encodeURIComponent(value)}`;
    }
    return '';
  }
  if (!/^\/studios(?:\?[^#]*)?$/.test(requested)) return '';
  const params = new URLSearchParams(requested.split('?')[1] || '');
  for (const key of params.keys()) {
    if (!['event', 'create'].includes(key) || params.getAll(key).length !== 1) return '';
  }
  if (params.has('event') && !getCommunityEvent(params.get('event'))) return '';
  if (params.has('create') && params.get('create') !== '1') return '';
  return requested;
}
