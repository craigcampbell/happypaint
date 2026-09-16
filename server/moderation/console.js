// Moderation console helpers: pure, dependency-free, synchronous.
//
// server.js exposes the admin-guarded endpoints (/api/admin/radar,
// /api/admin/users-index, /api/admin/rooms/:id/chat/summary); every summarising
// rule lives here so the same judgement applies to a room row, a chat digest
// and a user's risk score, and so the rules can be exercised without a server.
//
// Two layers of judgement:
//   1. What the server ALREADY decided at send time — the chat audit log carries
//      `blocked: 'severe' | 'mild'` + `terms` from server/moderation/textFilter.js.
//      The digest just counts what was recorded; it never re-litigates it.
//   2. What textFilter deliberately does NOT police — contact-sharing (discord /
//      snap / phone numbers), grooming-shaped phrasing, and cross-room patterns
//      (one user touring every room) — because those are contextual, not
//      word-level. Those are surfaced as "worth a look", never auto-actioned.

// Contact-sharing / off-platform invitation shapes. Kid-safe rooms lose nothing
// by making these reviewable: a 9-year-old has no legitimate reason to trade a
// phone number in a shared canvas.
export const CONTACT_RE = new RegExp(
  [
    '\\b(discord|snap ?chat|snap|kik|insta(gram)?|tiktok|whats ?app|telegram|signal|venmo|cash ?app|roblox|fortnite)\\b',
    '[a-z0-9._-]+@[a-z0-9-]+\\.[a-z]{2,}', // an email
    '(?:\\+?\\d[\\d\\s().-]{7,}\\d)', // a phone number
  ].join('|'),
  'i',
);

// Grooming / self-harm / contact-intent phrasing (mirrors the report-triage
// keyword set in fileReport() so a room's chat digest and its report queue agree
// about what "urgent" means).
export const CONCERN_RE = new RegExp(
  [
    '\\b(sexual|nude|naked|nsfw|porn|meet\\s?up|meet me|send (?:me )?(?:a )?(?:pic|photo)|address|phone)',
    '|\\b(kill (?:you|myself)|suicide|self.?harm|groom|do you go to|what school|how old)\\b',
  ].join(''),
  'i',
);

const MAX_SAMPLE = 160;

function clip(s) {
  const str = typeof s === 'string' ? s : '';
  return str.length > MAX_SAMPLE ? `${str.slice(0, MAX_SAMPLE - 1)}…` : str;
}

// digestChat(entries) → a moderator-readable summary of one room's chat audit
// tail. `entries` are the parsed audit lines ({ts, name, message, blocked,
// terms, doodle} — see appendChatAudit in server.js), newest-last is not
// assumed: everything is derived by scanning once.
export function digestChat(entries, { flaggedLimit = 8, authorLimit = 6 } = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const termCounts = new Map();
  const severeTerms = new Set();
  const authorCounts = new Map();
  const flagged = [];
  const digest = {
    lines: list.length,
    lastTs: 0,
    blocked: 0,
    severe: 0,
    mild: 0,
    contact: 0,
    concern: 0,
    doodles: 0,
    terms: [],
    authors: [],
    flagged: [],
    lastFlaggedTs: 0,
    needsReview: false,
  };

  for (const entry of list) {
    const ts = Number(entry.ts) || 0;
    if (ts > digest.lastTs) digest.lastTs = ts;

    const message = typeof entry.message === 'string' ? entry.message : '';
    const name = typeof entry.name === 'string' && entry.name ? entry.name : '?';
    authorCounts.set(name, (authorCounts.get(name) || 0) + 1);
    if (entry.doodle) digest.doodles += 1;

    const why = [];
    if (entry.blocked) {
      digest.blocked += 1;
      if (entry.blocked === 'severe') digest.severe += 1;
      else digest.mild += 1;
      why.push(`filter:${entry.blocked}`);
      if (Array.isArray(entry.terms)) {
        for (const term of entry.terms) {
          const key = String(term).slice(0, 24);
          termCounts.set(key, (termCounts.get(key) || 0) + 1);
          // A slur is not just another row in the list: severe terms rank above
          // mild ones at equal counts, so the worst word is never buried.
          if (entry.blocked === 'severe') severeTerms.add(key);
        }
      }
    }
    // An image can't be read by a word filter — a flagged doodle is context the
    // moderator has to look at themselves.
    if (entry.doodle && entry.blocked) why.push('flagged doodle');
    if (message && CONTACT_RE.test(message)) {
      digest.contact += 1;
      why.push('contact-sharing');
    }
    if (message && CONCERN_RE.test(message)) {
      digest.concern += 1;
      why.push('concern-phrase');
    }
    if (ts > digest.lastFlaggedTs && why.length) digest.lastFlaggedTs = ts;

    if (why.length && flagged.length < flaggedLimit) {
      flagged.push({
        ts,
        name,
        blocked: entry.blocked || null,
        terms: Array.isArray(entry.terms) ? entry.terms.slice(0, 6) : null,
        why,
        message: clip(message),
      });
    }
  }

  digest.terms = [...termCounts.entries()]
    .sort((a, b) => (
      (severeTerms.has(b[0]) ? 1 : 0) - (severeTerms.has(a[0]) ? 1 : 0)
      || b[1] - a[1]
      || a[0].localeCompare(b[0])
    ))
    .slice(0, 8)
    .map(([term, count]) => ({ term, count, severe: severeTerms.has(term) }));
  digest.authors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, authorLimit)
    .map(([name, count]) => ({ name, count }));

  // Newest first: a moderator reads backwards from now.
  flagged.sort((a, b) => b.ts - a.ts);
  digest.flagged = flagged;
  digest.needsReview = digest.severe > 0 || digest.contact > 0 || digest.concern > 0;
  return digest;
}

// Summarize a room's reports (the same array /api/admin/reports serves) into the
// per-room row the console highlights. A room with an open report gets painted;
// an urgent one gets painted harder.
export function summarizeReports(reports, roomCode) {
  const code = String(roomCode || '').toUpperCase();
  const mine = (Array.isArray(reports) ? reports : []).filter((r) => r && String(r.room).toUpperCase() === code);
  const out = { total: mine.length, open: 0, urgent: 0, lastTs: 0, lastReason: null, lastSource: null, lastStatus: null };
  for (const r of mine) {
    const ts = Number(r.ts) || 0;
    if (r.status === 'open') out.open += 1;
    if (r.urgent) out.urgent += 1;
    if (ts >= out.lastTs) {
      out.lastTs = ts;
      out.lastReason = typeof r.reason === 'string' ? clip(r.reason) : null;
      out.lastSource = r.source || null;
      out.lastStatus = r.status || null;
    }
  }
  return out;
}

// userRisk(user, sessions) → the "is this person touring the site to deface it"
// signal. Deliberately explainable: every point comes with a reason string a
// moderator can read, because an unexplained score is not actionable and a
// wrong ban has a real cost on a kids' app.
//
// `user` is an analytics.users entry ({rooms, strokes, drawOps, clears, chats,
// sessions, ...}); `sessions` are that user's analytics.sessions entries.
export function userRisk(user, sessions = [], { windowMs = 30 * 60 * 1000 } = {}) {
  const u = user || {};
  const roomsBag = u.rooms && typeof u.rooms === 'object' ? u.rooms : {};
  const distinctRooms = Object.keys(roomsBag).length;
  const now = Date.now();
  const recent = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => now - (Number(s.joinedAt) || 0) <= windowMs,
  );
  const recentRooms = new Set(recent.map((s) => String(s.room || '')).filter(Boolean));
  const clears = Number(u.clears) || 0;
  const strokes = Number(u.strokes) || 0;
  const reasons = [];
  let score = 0;

  if (distinctRooms >= 5) {
    score += Math.min(30, distinctRooms * 2);
    reasons.push(`visited ${distinctRooms} different rooms`);
  }
  if (recentRooms.size >= 3) {
    score += recentRooms.size * 4;
    reasons.push(`${recentRooms.size} rooms in the last 30 min`);
  }
  // Clearing a shared canvas is the bluntest defacement move there is — a kid
  // who clears five strangers' canvases is not exploring, they are wiping.
  if (clears >= 3) {
    score += Math.min(30, clears * 3);
    reasons.push(`cleared a canvas ${clears}×`);
  }
  // Touring without drawing: joins rooms, leaves little of their own.
  if (distinctRooms >= 4 && strokes > 0 && strokes < distinctRooms * 3) {
    score += 8;
    reasons.push('hopped rooms while drawing almost nothing');
  }
  if (Number(u.mutedCount) > 0) {
    score += 6;
    reasons.push('muted by a host');
  }
  if (u.blocked) {
    score += 20;
    reasons.push('currently blocked');
  }

  return {
    score: Math.min(100, score),
    distinctRooms,
    roomsRecent: [...recentRooms],
    clears,
    strokes,
    reasons,
  };
}

// The score → band mapping lives here so every surface agrees, and so changing
// what counts as "watch this person" is one edit in one file (the console just
// renders the band).
export function riskBand(score) {
  const n = Number(score) || 0;
  if (n >= 50) return 'high';
  if (n >= 20) return 'watch';
  return 'low';
}
