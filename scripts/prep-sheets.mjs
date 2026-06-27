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

// ---- Auto-classifier ------------------------------------------------------
// Each sheet is tagged with one or more kid-friendly categories, derived from
// the descriptive filename words (no AI needed). A sheet can belong to several
// categories (e.g. "4th of july cupcake" -> holidays + food) for better filter
// recall. Keys here must match the CATEGORIES list in ColoringSheetModal.jsx.
const CATEGORY_KEYWORDS = {
  animals: ['animal', 'pet', 'zoo', 'farm', 'dog', 'puppy', 'cat', 'kitten', 'kitty', 'cow', 'horse', 'pony', 'pig', 'piglet', 'sheep', 'lamb', 'goat', 'lion', 'tiger', 'bear', 'panda', 'koala', 'elephant', 'monkey', 'gorilla', 'fox', 'rabbit', 'bunny', 'hamster', 'squirrel', 'mouse', 'bird', 'owl', 'duck', 'chick', 'chicken', 'rooster', 'eagle', 'parrot', 'peacock', 'flamingo', 'penguin', 'swan', 'goose', 'fish', 'shark', 'whale', 'dolphin', 'octopus', 'crab', 'lobster', 'seahorse', 'jellyfish', 'starfish', 'turtle', 'tortoise', 'frog', 'snake', 'lizard', 'gecko', 'dinosaur', 'dino', 'dragonfly', 'butterfly', 'bee', 'ladybug', 'snail', 'spider', 'ant', 'caterpillar', 'giraffe', 'zebra', 'deer', 'moose', 'wolf', 'bat', 'hedgehog', 'raccoon', 'seal', 'walrus', 'otter', 'crocodile', 'alligator', 'hippo', 'rhino', 'kangaroo', 'camel', 'llama', 'alpaca', 'sloth'],
  fantasy: ['princess', 'prince', 'queen', 'king', 'dragon', 'unicorn', 'fairy', 'mermaid', 'superhero', 'hero', 'robot', 'monster', 'wizard', 'magic', 'magical', 'castle', 'knight', 'alien', 'ufo', 'rocket', 'spaceship', 'astronaut', 'space', 'genie', 'troll', 'elf', 'gnome', 'pirate', 'ninja', 'brainrot', 'tralalero', 'phantom', 'portal'],
  vehicles: ['car', 'truck', 'bus', 'train', 'plane', 'airplane', 'jet', 'boat', 'ship', 'sailboat', 'tractor', 'ambulance', 'helicopter', 'bike', 'bicycle', 'scooter', 'motorcycle', 'digger', 'excavator', 'bulldozer', 'crane', 'van', 'taxi', 'submarine', 'wagon', 'sled', 'forklift', 'tank', 'rover', 'vehicle'],
  sports: ['soccer', 'ball', 'basketball', 'baseball', 'football', 'tennis', 'volleyball', 'hockey', 'golf', 'swim', 'swimming', 'skate', 'skateboard', 'surf', 'ski', 'snowboard', 'kite', 'playground', 'slide', 'swing', 'gymnast', 'karate', 'dance', 'dancing', 'dancer', 'bowling', 'race', 'racing', 'champion', 'runner', 'jump', 'cycling', 'fishing'],
  food: ['cake', 'cupcake', 'cookie', 'candy', 'donut', 'doughnut', 'pizza', 'fruit', 'apple', 'banana', 'grape', 'strawberry', 'watermelon', 'melon', 'carrot', 'corn', 'popsicle', 'lollipop', 'bakery', 'pie', 'burger', 'hamburger', 'sandwich', 'taco', 'sushi', 'bread', 'cheese', 'pretzel', 'pancake', 'waffle', 'muffin', 'bagel', 'sundae', 'smoothie', 'snack', 'popcorn', 'cherry', 'peach', 'pear', 'lemon', 'mango', 'pineapple', 'coconut', 'cream'],
  nature: ['flower', 'tree', 'garden', 'rainbow', 'sun', 'sunshine', 'cloud', 'rain', 'rainy', 'snow', 'snowflake', 'snowman', 'beach', 'ocean', 'sea', 'wave', 'mountain', 'forest', 'jungle', 'leaf', 'plant', 'moon', 'weather', 'river', 'lake', 'waterfall', 'island', 'volcano', 'cactus', 'mushroom', 'tulip', 'rose', 'daisy', 'sunflower', 'nature', 'outdoor', 'park', 'field', 'meadow', 'pond', 'hill', 'sky', 'season', 'autumn', 'spring', 'summer', 'winter', 'camping'],
  people: ['boy', 'girl', 'baby', 'kid', 'child', 'children', 'toddler', 'mom', 'mum', 'mother', 'dad', 'father', 'family', 'grandma', 'grandpa', 'teacher', 'doctor', 'nurse', 'firefighter', 'fireman', 'policeman', 'officer', 'chef', 'cook', 'cashier', 'farmer', 'pilot', 'dentist', 'mailman', 'friend', 'people', 'person', 'lady', 'graduate', 'diploma', 'student', 'school', 'baker', 'builder', 'artist'],
  learning: ['letter', 'alphabet', 'abc', 'number', 'count', 'counting', 'math', 'shape', 'spelling', 'word'],
  birthday: ['birthday', 'party', 'balloon'],
  holidays: ['christmas', 'santa', 'xmas', 'reindeer', 'halloween', 'pumpkin', 'spooky', 'ghost', 'witch', 'skeleton', 'easter', 'valentine', 'cupid', 'thanksgiving', 'turkey', 'july', 'fireworks', 'firework', 'patriotic', 'leprechaun', 'patrick', 'shamrock', 'clover', 'hanukkah', 'menorah', 'diwali', 'mardi', 'gras', 'holiday', 'festive', 'lunar', 'ramadan', 'kwanzaa', 'carnival'],
};
function categorize(qWords) {
  const set = new Set(qWords);
  const has = (kw) => set.has(kw) || set.has(`${kw}s`) || set.has(`${kw}es`);
  const cats = [];
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(has)) cats.push(cat);
  }
  return cats.length ? cats : ['other'];
}

const index = [];
let done = 0;
let made = 0;
let failed = 0;

async function processOne(file) {
  const id = file.replace(/\.png$/i, '');
  const words = wordsOf(file);
  const qWords = words.filter((w) => !STOP.has(w));
  const q = qWords.join(' ');
  index.push({ id, title: titleOf(words), q, cats: categorize(qWords) });

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
