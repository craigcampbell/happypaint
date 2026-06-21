// One-time (idempotent) prep for the coloring-sheet library.
//   1. Moves the source PNGs into coloring-library/full/.
//   2. Generates a 256px webp thumbnail per sheet in coloring-library/thumbs/.
//   3. Builds coloring-library/index.json (id + title + searchable text) from the
//      descriptive filenames — no AI classifier needed.
//
// Run: node scripts/prep-sheets.mjs
// Re-runnable: only missing thumbnails are regenerated.

import { readdirSync, mkdirSync, existsSync, renameSync, copyFileSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src', 'coloring-sheets'); // where the user dropped them
const LIB = join(ROOT, 'coloring-library');
const FULL = join(LIB, 'full');
const THUMBS = join(LIB, 'thumbs');
const INDEX = join(LIB, 'index.json');
const THUMB_SIZE = 256;
const CONCURRENCY = 8;

mkdirSync(FULL, { recursive: true });
mkdirSync(THUMBS, { recursive: true });

// 1) Move source PNGs into the library (rename on same volume; copy+unlink fallback).
if (existsSync(SRC)) {
  const srcFiles = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.png'));
  let moved = 0;
  for (const f of srcFiles) {
    const dest = join(FULL, f);
    if (existsSync(dest)) continue;
    try {
      renameSync(join(SRC, f), dest);
    } catch {
      copyFileSync(join(SRC, f), dest);
      try { unlinkSync(join(SRC, f)); } catch { /* leave source */ }
    }
    moved += 1;
  }
  if (moved) console.log(`Moved ${moved} sheets into ${FULL}`);
}

const files = readdirSync(FULL).filter((f) => f.toLowerCase().endsWith('.png'));
console.log(`Indexing ${files.length} sheets…`);

const STOP = new Set(['coloring', 'page', 'free', 'a', 'an', 'the', 'of', 'on', 'in', 'with', 'and', 'to']);
function wordsOf(base) {
  let s = base.toLowerCase().replace(/\.png$/, '');
  s = s.replace(/-coloring-page(-free)?$/, '').replace(/-free$/, '').replace(/^\d+-/, '');
  return s.split(/[-_]/).filter(Boolean);
}
function titleOf(words) {
  const t = words.filter((w) => !['coloring', 'page', 'free'].includes(w));
  return t.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Coloring sheet';
}

const index = [];
let done = 0;
let made = 0;
let failed = 0;

async function processOne(file) {
  const id = file.replace(/\.png$/i, '');
  const words = wordsOf(file);
  const q = words.filter((w) => !STOP.has(w)).join(' ');
  index.push({ id, title: titleOf(words), q });

  const thumbPath = join(THUMBS, `${id}.webp`);
  if (!existsSync(thumbPath)) {
    try {
      await sharp(join(FULL, file))
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(thumbPath);
      made += 1;
    } catch {
      failed += 1;
    }
  }
  done += 1;
  if (done % 500 === 0) console.log(`  ${done}/${files.length} (thumbs +${made}, failed ${failed})`);
}

async function run() {
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const idx = i;
      i += 1;
      // eslint-disable-next-line no-await-in-loop
      await processOne(files[idx]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  index.sort((a, b) => a.title.localeCompare(b.title));
  writeFileSync(INDEX, JSON.stringify({ count: index.length, sheets: index }));
  console.log(`Done: ${index.length} indexed, ${made} thumbnails made, ${failed} failed.`);
  console.log(`Index -> ${INDEX}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
