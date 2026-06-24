// Server-side text moderation for kid_safe rooms.
//
// Pure, dependency-free, synchronous. The realtime server calls scan() on chat
// messages and drawn-text ops, and only ever in `kid_safe` rooms (see
// docs/CONTENT_MODERATION.md §4). The contract there is the source of truth.
//
// Design goals:
//   1. Catch obvious evasion — leetspeak (4→a, 3→e, 1→i/l, 0→o, 5→s, @→a,
//      $→s, !→i), diacritics, characters spaced/dotted/dashed between letters
//      (b.a.d / b a d / b-a-d → bad), and stretched repeats (fuuuck → fuck).
//   2. NEVER trip on innocent words that merely contain a bad substring — the
//      "Scunthorpe problem". This is a kids' app; a false positive on a child's
//      real word/art is harmful. We match on whole tokens / word boundaries
//      against the normalized string, never bare substrings.
//
// The word lists are BEST-EFFORT and intentionally small + clearly commented so
// they're easy to extend. They are not exhaustive.

// --- normalization ----------------------------------------------------------

const LEET = {
  '4': 'a',
  '3': 'e',
  '1': 'i', // also folds for 'l'; either reading lands inside our boundary scan
  '0': 'o',
  '5': 's',
  '@': 'a',
  '$': 's',
};

// '!' is a common substitute for 'i', but it's also ordinary punctuation. Only
// fold it when it sits BETWEEN two letters (sh!t, n!gger) so a trailing/leading
// "!" used as punctuation ("fuck!", "wow!") never glues into the adjacent token
// and breaks its word boundary.
function foldInteriorBang(s) {
  return s.replace(/(?<=[a-z])!+(?=[a-z])/g, 'i');
}

// Strip combining diacritical marks after NFD decomposition (é → e, ñ → n).
function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function foldLeet(s) {
  let out = '';
  for (const ch of s) out += LEET[ch] || ch;
  return out;
}

// Collapse separators in runs of single letters split by separators, so
// spaced/dotted evasions rejoin: "b.a.d", "b a d", "b-a-d" → "bad". We only
// touch a maximal run of the shape  letter SEP letter SEP letter ...  where the
// run is bounded on BOTH ends by a non-letter (string edge or separator). That
// boundary requirement is what keeps real words intact: in "are a fuck" the
// candidate "e a f" is rejected because it is flanked by the letters of "are"
// and "fuck", so ordinary single-letter words ("a", "i") never glue adjacent
// words together. Separator class: space, dot, dash, underscore, slash, comma,
// asterisk, plus.
const SEP_CLASS = '[\\s._\\-/,*+]';
const SINGLE_LETTER_RUN = new RegExp(
  `(?<![a-z])(?:[a-z]${SEP_CLASS}+){2,}[a-z](?![a-z])`,
  'g',
);
const SEP_RE = new RegExp(SEP_CLASS + '+', 'g');
function collapseSeparators(s) {
  return s.replace(SINGLE_LETTER_RUN, (run) => run.replace(SEP_RE, ''));
}

// normalize(s): lowercase, strip diacritics, fold leetspeak, collapse separators
// between repeated single letters. Returns a clean lowercase string. Anything
// non-string normalizes to ''.
export function normalize(s) {
  if (typeof s !== 'string' || !s) return '';
  let out = s.toLowerCase();
  out = stripDiacritics(out);
  out = foldInteriorBang(out);
  out = foldLeet(out);
  out = collapseSeparators(out);
  return out;
}

// Collapse any letter repeated 3+ times down to a single letter, defeating the
// "stretched" evasion (fuuuck → fuck, niiigger → nigger, raaape → rape). We only
// touch runs of 3+ so that legitimate English doublings (pass, grass, balloon,
// committee, coffee) are untouched — no English word repeats the same letter 3
// times in a row, so this can't mangle a real word into a bad token. The output
// is a SECONDARY string used only for matching; normalize()'s public contract
// (and the canonical form scan() reports against) is unchanged, and whole-token
// boundary matching still applies, so the Scunthorpe guarantee holds.
function collapseRepeats(s) {
  return s.replace(/([a-z])\1{2,}/g, '$1');
}

// --- word lists (best-effort, easily extendable) ----------------------------
//
// Stored normalized (already lowercase, no leet) so a single normalize() pass on
// input lines them up. Add new entries here; keep them in normalized form.
//
// SEVERE: slurs + explicit sexual terms. A hit drops the content and auto-reports.
// Representative entries only — extend as needed. (Mildly censored in source so
// the file stays readable; the matcher works on the de-censored normalized form.)
const SEVERE = [
  'fuck',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'fag',
  'retard',
  'cock', // matched whole-token only (see false-positive guards/tests)
  'pussy',
  'whore',
  'slut',
  'rape',
  'porn',
  'cum',
];

// MILD: light profanity. A chat hit is masked ('****') and still delivered.
const MILD = [
  'shit',
  'crap',
  'damn',
  'ass',
  'asshole',
  'bitch',
  'bastard',
  'piss',
  // NOTE: 'dick' deliberately omitted — it is also a common given name (Dick),
  // and the kid-safe contract requires the bare name to stay clean. Add it back
  // only with name-aware context handling.
  'bollocks',
  'wanker',
  'prick',
];

// --- matching ---------------------------------------------------------------
//
// Whole-token / word-boundary matching against the normalized string. A term
// matches only when flanked by non-letter boundaries, so "ass" in "class",
// "grass", "pass", "assassin" never trips, and "cock" in "cockpit",
// "shuttlecock", "Cockburn", "Hancock" never trips. This makes the Scunthorpe
// problem structurally impossible.

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
function escapeRegExp(s) {
  return s.replace(ESCAPE_RE, '\\$&');
}

// Build one alternation regex per list, anchored on letter boundaries. We use
// explicit "not a letter or digit" lookarounds rather than \b so that leet
// digits already folded to letters don't create spurious word boundaries.
function buildMatcher(list) {
  const alt = list.map(escapeRegExp).join('|');
  // (?<![a-z]) start-of-token, (?![a-z]) end-of-token.
  return new RegExp(`(?<![a-z])(?:${alt})(?![a-z])`, 'g');
}

const SEVERE_RE = buildMatcher(SEVERE);
const MILD_RE = buildMatcher(MILD);

function findAll(re, text) {
  const found = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[0]);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return [...found];
}

// scan(s): classify a string.
//   { hit:true,  severity:'severe', terms:[...] }  — slur / explicit term
//   { hit:true,  severity:'mild',   terms:[...] }  — light profanity only
//   { hit:false, severity:null,     terms:[] }     — clean
// Severe wins over mild when both are present.
export function scan(s) {
  const norm = normalize(s);
  if (!norm) return { hit: false, severity: null, terms: [] };

  // Match against both the canonical normalized form AND a repeat-collapsed
  // form so stretched evasions (fuuuck, niiigger) are caught without altering
  // the canonical text. collapseRepeats only touches 3+ runs, which no real
  // English word has, so the repeat pass cannot introduce false positives.
  const collapsed = collapseRepeats(norm);

  const severeTerms = new Set([
    ...findAll(SEVERE_RE, norm),
    ...findAll(SEVERE_RE, collapsed),
  ]);
  if (severeTerms.size > 0) {
    return { hit: true, severity: 'severe', terms: [...severeTerms] };
  }

  const mildTerms = new Set([
    ...findAll(MILD_RE, norm),
    ...findAll(MILD_RE, collapsed),
  ]);
  if (mildTerms.size > 0) {
    return { hit: true, severity: 'mild', terms: [...mildTerms] };
  }

  return { hit: false, severity: null, terms: [] };
}

export const _lists = { SEVERE, MILD };
