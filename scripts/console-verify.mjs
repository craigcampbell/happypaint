// Throwaway check of the console data layer (pure functions, no server).
import { digestChat, summarizeReports, userRisk, riskBand, CONTACT_RE, CONCERN_RE } from '../server/moderation/console.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };

// --- digestChat ------------------------------------------------------------
const entries = [
  { ts: 1000, name: 'Zoe', message: 'look at my dino!' },
  { ts: 2000, name: 'Sam', message: 'badword here', blocked: 'mild', terms: ['damn'] },
  { ts: 3000, name: 'Troll', message: 'add me on discord: troll#12', blocked: 'severe', terms: ['fuck'] },
  { ts: 4000, name: 'Troll', message: 'my number is 512-555-1234' },
  { ts: 5000, name: 'Ana', message: 'draw a castle', doodle: 'doodle_1' },
  { ts: 6000, name: 'Zoe', message: 'what school do you go to?' },
];
const d = digestChat(entries);
ok('counts every line', d.lines === 6, JSON.stringify(d.lines));
ok('severity split from the audit log', d.severe === 1 && d.mild === 1 && d.blocked === 2, `${d.severe}/${d.mild}/${d.blocked}`);
ok('Contact sharing caught (discord handle + phone)', d.contact === 2, String(d.contact));
ok('concern phrase caught', d.concern === 1, String(d.concern));
ok('flagged entries carry why + name', d.flagged.length === 4 && d.flagged.every((f) => f.why.length && f.name), JSON.stringify(d.flagged.map((f) => f.why)));
ok('newest flagged first', d.flagged[0].ts === 6000, String(d.flagged[0].ts));
ok('lastFlaggedTs tracks the latest', d.lastFlaggedTs === 6000, String(d.lastFlaggedTs));
ok('terms ranked severe-first then by count', d.terms[0].term === 'fuck' && d.terms[0].severe === true, JSON.stringify(d.terms));
ok('authors ranked by message count', d.authors[0].count === 2 && d.authors[1].count === 2 && d.authors[2].count === 1, JSON.stringify(d.authors));
ok('needsReview set', d.needsReview === true);

const clean = digestChat([{ ts: 10, name: 'Kid', message: 'i like turtles' }]);
ok('a clean room is not flagged', clean.needsReview === false && clean.flagged.length === 0 && clean.lastTs === 10);

// Scunthorpe guard: innocent words must not trip the console's own patterns.
const innocent = digestChat([
  { ts: 1, name: 'A', message: 'my class is fun and the grass is green' },
  { ts: 2, name: 'B', message: 'I passed the ball to Assassin' },
  { ts: 3, name: 'C', message: 'a cockpit and a shuttlecock' },
]);
ok('no false positives on innocent words', innocent.needsReview === false, JSON.stringify(innocent));

// --- summarizeReports ------------------------------------------------------
const reports = [
  { id: 'r1', room: 'DINOS', reason: 'rude drawing', ts: 100, status: 'open', source: 'user' },
  { id: 'r2', room: 'DINOS', reason: 'sexual content', ts: 200, status: 'open', urgent: true, source: 'auto' },
  { id: 'r3', room: 'MAIN', reason: 'noise', ts: 300, status: 'resolved', source: 'user' },
];
const sd = summarizeReports(reports, 'dinos');
ok('per-room report rollup', sd.total === 2 && sd.open === 2 && sd.urgent === 1, JSON.stringify(sd));
ok('latest report details win', sd.lastTs === 200 && sd.lastReason === 'sexual content' && sd.lastSource === 'auto', JSON.stringify(sd));
ok('a clean room rolls up empty', summarizeReports(reports, 'ZZZZ').total === 0);

// --- userRisk --------------------------------------------------------------
const now = Date.now();
const tourist = {
  rooms: Object.fromEntries(['MAIN', 'DINOS', 'SPACE', 'PETS', 'OCEAN', 'DOODLE'].map((c) => [c, 1])),
  strokes: 4, clears: 5, chats: 1, sessions: 6, blocked: false,
};
const touristSessions = ['MAIN', 'DINOS', 'SPACE', 'PETS'].map((room, i) => ({ room, joinedAt: now - i * 60_000 }));
const rt = userRisk(tourist, touristSessions);
ok('tourist is high risk', rt.score >= 50 && riskBand(rt.score) === 'high', JSON.stringify(rt));
ok('risk is explained', rt.reasons.some((r) => /different rooms/.test(r)) && rt.reasons.some((r) => /cleared a canvas/.test(r)), JSON.stringify(rt.reasons));
ok('bands agree with scores', riskBand(0) === 'low' && riskBand(25) === 'watch' && riskBand(80) === 'high');

const normal = userRisk({ rooms: { MAIN: 3 }, strokes: 900, clears: 0, sessions: 2 }, [{ room: 'MAIN', joinedAt: now - 1000 }]);
ok('a normal painter scores low', normal.score < 10, JSON.stringify(normal));
ok('no rooms visited → no reasons', userRisk({}, []).reasons.length === 0);

// --- pattern sanity --------------------------------------------------------
ok('CONTACT_RE ignores plain text', !CONTACT_RE.test('i drew a cat and a dog'));
ok('CONCERN_RE ignores plain text', !CONCERN_RE.test('lets draw together'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
