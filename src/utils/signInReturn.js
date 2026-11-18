import { getCommunityEvent } from '../data/communityEvents.js';

// A closed internal-destination allowlist, not an arbitrary URL redirect.
export function safeSignInReturn(requested) {
  if (typeof requested !== 'string') return '';
  if (/^\/(family|rooms|join\/[A-Z0-9]{1,8}|sketchbook(?:\/(?:invite\/[A-Za-z0-9_-]{1,96}|sb_[a-f0-9]{16}))?)$/.test(requested)) return requested;
  if (!/^\/studios(?:\?[^#]*)?$/.test(requested)) return '';
  const params = new URLSearchParams(requested.split('?')[1] || '');
  for (const key of params.keys()) {
    if (!['event', 'create'].includes(key) || params.getAll(key).length !== 1) return '';
  }
  if (params.has('event') && !getCommunityEvent(params.get('event'))) return '';
  if (params.has('create') && params.get('create') !== '1') return '';
  return requested;
}
