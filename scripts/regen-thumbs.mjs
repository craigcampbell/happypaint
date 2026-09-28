// Regenerate coloring-library thumbnails from the current full/ PNGs.
//
// scripts/prep-sheets.mjs only fills in *missing* thumbnails, so after the
// sheet artwork itself changes (e.g. the watermark swap) every existing thumb
// is stale and must be rebuilt. Same spec as prep-sheets.mjs:
//   256px box, fit inside, no enlargement, webp quality 78.
//
// The host has no node_modules; run it through the app image (which ships
// sharp), bind-mounting the library read-write:
//
//   docker run --rm \
//     -v "$PWD/coloring-library:/app/coloring-library" \
//     -v "$PWD/scripts/regen-thumbs.mjs:/app/scripts/regen-thumbs.mjs" \
//     happypaint-app node scripts/regen-thumbs.mjs
//
// Options:
//   --only-missing   skip thumbs newer than their PNG (the fast path after a
//                    small change; useless after a bulk rewrite)
//   COLORING_LIB=<dir>   operate on a different library directory

import { readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = process.env.COLORING_LIB || join(__dirname, '..', 'coloring-library');
const FULL = join(LIB, 'full');
const THUMBS = join(LIB, 'thumbs');
const THUMB_SIZE = 256;
const QUALITY = 78;
const CONCURRENCY = 8;

const onlyMissing = process.argv.includes('--only-missing');

mkdirSync(THUMBS, { recursive: true });
const files = readdirSync(FULL).filter((f) => f.toLowerCase().endsWith('.png'));
console.log(`${files.length} sheets in ${FULL}, ${onlyMissing ? 'only missing' : 'rebuilding all'} thumbnails…`);

let done = 0;
let made = 0;
let skipped = 0;
let failed = 0;
let i = 0;

async function worker() {
  while (i < files.length) {
    const file = files[i];
    i += 1;
    const id = file.replace(/\.png$/i, '');
    const thumb = join(THUMBS, `${id}.webp`);
    if (onlyMissing && existsSync(thumb)
        && statSync(thumb).mtimeMs > statSync(join(FULL, file)).mtimeMs) {
      skipped += 1;
    } else {
      try {
        await sharp(join(FULL, file))
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: QUALITY })
          .toFile(thumb);
        made += 1;
      } catch (e) {
        failed += 1;
        console.error('  fail', file, e.message);
      }
    }
    done += 1;
    if (done % 500 === 0) console.log(`  ${done}/${files.length} (made ${made}, skipped ${skipped}, failed ${failed})`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Done: ${made} written, ${skipped} skipped, ${failed} failed.`);
