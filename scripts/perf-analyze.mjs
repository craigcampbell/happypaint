// Offline room-history diagnostic. Pass an explicit local data directory:
//   node scripts/perf-analyze.mjs <room-directory>
// No network calls or writes. Labels are anonymous; room names and op contents
// never enter the report. Gzip figures are estimates, not measured WS traffic.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const bytes = (value) => Buffer.byteLength(value, 'utf8');
const wireJson = (ops) => JSON.stringify({ type: 'history', ops });

export function analyzeHistory(data) {
  const ops = Array.isArray(data?.history) ? data.history : [];
  const settingsByStroke = new Map();
  const kinds = Object.create(null);
  let points = 0;
  let drawOps = 0;
  const compactOps = ops.map((op) => {
    const kind = typeof op?.kind === 'string' ? op.kind : '?';
    // Only report known protocol kinds; arbitrary strings may contain PII.
    const label = ['draw', 'shape', 'text', 'image'].includes(kind) ? kind : 'other';
    kinds[label] = (kinds[label] || 0) + 1;
    if (kind !== 'draw') return op;
    drawOps += 1;
    points += Array.isArray(op.points) ? op.points.length : 0;
    if (!op.strokeId) return op;
    // Authors and animation frames can reuse stroke IDs independently.
    const key = JSON.stringify([op.userId ?? null, op.frameId ?? null, op.strokeId]);
    const settings = JSON.stringify(op.settings);
    const seen = settingsByStroke.has(key);
    const previous = settingsByStroke.get(key);
    if (settings !== undefined || !seen) settingsByStroke.set(key, settings);
    // Preserve the first settings and every actual change. Continuation ops
    // without settings already use the compact protocol and need no rewrite.
    if (seen && settings !== undefined && settings === previous) {
      const compact = { ...op };
      delete compact.settings;
      return compact;
    }
    return op;
  });
  const original = wireJson(ops);
  const compact = wireJson(compactOps);
  return {
    ops: ops.length,
    drawOps,
    points,
    strokes: settingsByStroke.size,
    kinds,
    historyBytes: bytes(original),
    gzipBytes: gzipSync(original).length,
    compactBytes: bytes(compact),
    compactGzipBytes: gzipSync(compact).length,
  };
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'KB';
  return n + 'B';
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/perf-analyze.mjs <room-directory>');
    console.log('Reads local JSON only; reports anonymous labels and estimated gzip sizes.');
    return args.length === 1 ? 0 : 1;
  }
  const dir = resolve(args[0]);
  let files;
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name).sort();
  } catch {
    console.error('Cannot read the requested room directory.');
    return 1;
  }
  const rows = [];
  let skipped = 0;
  for (const [index, file] of files.entries()) {
    try {
      const raw = readFileSync(join(dir, file));
      const data = JSON.parse(raw.toString('utf8'));
      if (!data || !Array.isArray(data.history)) throw new Error('missing history');
      rows.push({ label: `room-${index + 1}`, file, diskBytes: raw.length, ...analyzeHistory(data) });
    } catch {
      skipped += 1;
      console.error(`room-${index + 1}: skipped unreadable or invalid room JSON`);
    }
  }
  rows.sort((a, b) => b.historyBytes - a.historyBytes);
  console.log('Room history estimates (gzip is not a WS measurement)');
  console.log('room       disk       history    gzip       ops     points  strokes compact    compact-gzip kinds');
  for (const row of rows) {
    console.log([
      row.label.padEnd(10), fmt(row.diskBytes).padStart(10), fmt(row.historyBytes).padStart(10),
      fmt(row.gzipBytes).padStart(10), String(row.ops).padStart(7), String(row.points).padStart(8),
      String(row.strokes).padStart(7), fmt(row.compactBytes).padStart(10),
      fmt(row.compactGzipBytes).padStart(12), JSON.stringify(row.kinds),
    ].join(' '));
  }
  const total = rows.reduce((sum, row) => {
    for (const key of Object.keys(sum)) sum[key] += row[key];
    return sum;
  }, { diskBytes: 0, historyBytes: 0, gzipBytes: 0, compactBytes: 0, compactGzipBytes: 0, ops: 0, points: 0 });
  const savings = (before, after) => before ? `${((1 - after / before) * 100).toFixed(1)}%` : 'n/a';
  console.log(`Totals: rooms=${rows.length} skipped=${skipped} disk=${fmt(total.diskBytes)} history=${fmt(total.historyBytes)} gzip=${fmt(total.gzipBytes)} ops=${total.ops} points=${total.points}`);
  console.log(`Settings-dedup savings: raw=${savings(total.historyBytes, total.compactBytes)} gzip=${savings(total.gzipBytes, total.compactGzipBytes)}`);

  // Time a synthetic join envelope for the largest readable history. No room
  // metadata (including credentials or names) enters the estimated wire data.
  const biggest = rows[0];
  if (biggest) {
    try {
      const raw = readFileSync(join(dir, biggest.file));
      const t0 = process.hrtime.bigint();
      const parsed = JSON.parse(raw.toString('utf8'));
      const t1 = process.hrtime.bigint();
      const str = wireJson(parsed.history);
      const t2 = process.hrtime.bigint();
      const compressed = gzipSync(str);
      const t3 = process.hrtime.bigint();
      const ms = (a, b) => (Number(b - a) / 1e6).toFixed(1);
      console.log(`Largest history (${biggest.label}): parse=${ms(t0, t1)}ms stringify=${ms(t1, t2)}ms gzip=${ms(t2, t3)}ms estimated-gzip=${fmt(compressed.length)}`);
    } catch {
      console.error('Largest room changed during analysis; timing skipped.');
    }
  }
  return skipped ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
