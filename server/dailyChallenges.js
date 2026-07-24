// The Daily Challenge — one fresh, kid-safe drawing prompt per UTC day.
//
// Deterministic: every server (and every restart) computes the same challenge
// for the same date, so the homepage, the DAILY room and the wall tag all
// agree with no stored state. The pick strides the curated list with a large
// prime so consecutive days feel unrelated (not an alphabetical crawl), and
// the whole list plays out before any repeat (prime stride ⇒ full cycle).
//
// Curated in-repo on purpose: no user text, no runtime generation — nothing to
// moderate. Keep prompts concrete + drawable in ~10 minutes, silly over subtle
// (kids AND teens), and never scary/branded/violent.

const CHALLENGES = [
  { prompt: 'A grumpy dragon who lost its sock', emoji: '🐉' },
  { prompt: 'Your pet as a superhero', emoji: '🦸' },
  { prompt: 'A robot making breakfast', emoji: '🤖' },
  { prompt: 'An octopus juggling donuts', emoji: '🐙' },
  { prompt: 'The world’s fluffiest cloud castle', emoji: '☁️' },
  { prompt: 'A dinosaur at a birthday party', emoji: '🦕' },
  { prompt: 'A cat driving a race car', emoji: '🏎️' },
  { prompt: 'The moon eating a midnight snack', emoji: '🌙' },
  { prompt: 'A penguin on summer vacation', emoji: '🐧' },
  { prompt: 'Your dream treehouse', emoji: '🌳' },
  { prompt: 'A pizza with very wrong toppings', emoji: '🍕' },
  { prompt: 'A tiny knight fighting a giant marshmallow', emoji: '⚔️' },
  { prompt: 'A mermaid’s messy bedroom', emoji: '🧜' },
  { prompt: 'An alien’s first day at school', emoji: '👽' },
  { prompt: 'A hamster piloting a spaceship', emoji: '🐹' },
  { prompt: 'The rainiest day ever (with happy frogs)', emoji: '🐸' },
  { prompt: 'A wizard whose spells keep going wrong', emoji: '🧙' },
  { prompt: 'A sloth winning a race somehow', emoji: '🦥' },
  { prompt: 'An ice cream cone on the beach', emoji: '🍦' },
  { prompt: 'A monster who is scared of the dark', emoji: '👹' },
  { prompt: 'Your favorite food with a face', emoji: '😋' },
  { prompt: 'A unicorn stuck in traffic', emoji: '🦄' },
  { prompt: 'A pirate ship sailing through the sky', emoji: '🏴‍☠️' },
  { prompt: 'A bee’s tiny house inside a flower', emoji: '🐝' },
  { prompt: 'A snowman on a tropical island', emoji: '⛄' },
  { prompt: 'The king or queen of the vegetables', emoji: '👑' },
  { prompt: 'A dog walking its human', emoji: '🐕' },
  { prompt: 'A secret door in your school', emoji: '🚪' },
  { prompt: 'An upside-down city', emoji: '🙃' },
  { prompt: 'A turtle carrying its whole town', emoji: '🐢' },
  { prompt: 'Fireworks made of candy', emoji: '🎆' },
  { prompt: 'A ghost trying to make friends', emoji: '👻' },
  { prompt: 'The biggest sandwich in the universe', emoji: '🥪' },
  { prompt: 'A fox reading bedtime stories', emoji: '🦊' },
  { prompt: 'Roller-skating dinosaurs', emoji: '🛼' },
  { prompt: 'A garden where instruments grow', emoji: '🎸' },
  { prompt: 'A whale hot-air balloon', emoji: '🐋' },
  { prompt: 'Breakfast on top of a mountain', emoji: '⛰️' },
  { prompt: 'A crab hosting a talent show', emoji: '🦀' },
  { prompt: 'The world seen by an ant', emoji: '🐜' },
  { prompt: 'A dragon learning to bake cookies', emoji: '🍪' },
  { prompt: 'Your house but it’s a boat', emoji: '⛵' },
  { prompt: 'A raccoon detective on the case', emoji: '🕵️' },
  { prompt: 'The friendliest swamp monster', emoji: '🐊' },
  { prompt: 'A parade of umbrellas in the rain', emoji: '☔' },
  { prompt: 'A koala barista making tiny coffees', emoji: '🐨' },
  { prompt: 'The library where books fly home at night', emoji: '📚' },
  { prompt: 'A volcano that erupts confetti', emoji: '🎉' },
  { prompt: 'An owl teaching a night class', emoji: '🦉' },
  { prompt: 'The tallest ice cream tower you can stack', emoji: '🍨' },
  { prompt: 'A bunny’s carrot rocket', emoji: '🥕' },
  { prompt: 'Underwater tea party', emoji: '🫖' },
  { prompt: 'A map of an imaginary island', emoji: '🗺️' },
  { prompt: 'The band where every player is a bug', emoji: '🪲' },
  { prompt: 'A cactus who wants a hug', emoji: '🌵' },
  { prompt: 'Skateboarding grandma', emoji: '🛹' },
  { prompt: 'A lighthouse for flying ships', emoji: '🗼' },
  { prompt: 'The mouse who lives in a teacup', emoji: '🐭' },
  { prompt: 'A rainbow-powered train', emoji: '🌈' },
  { prompt: 'Your favorite season as a person', emoji: '🍂' },
  { prompt: 'A shark who is a very gentle dentist', emoji: '🦈' },
  { prompt: 'The city of the future (with waterslides)', emoji: '🏙️' },
  { prompt: 'A duck army marching to the pond', emoji: '🦆' },
  { prompt: 'A picnic on the rings of Saturn', emoji: '🪐' },
  { prompt: 'The sleepiest bear’s cozy cave', emoji: '🐻' },
  { prompt: 'A flower that blooms candy', emoji: '🌸' },
  { prompt: 'Two snails racing (it’s very slow)', emoji: '🐌' },
  { prompt: 'The elevator that goes to the moon', emoji: '🛗' },
  { prompt: 'A tiger in fuzzy slippers', emoji: '🐯' },
  { prompt: 'Your name as a monster', emoji: '🔤' },
  { prompt: 'The bakery run by friendly ghosts', emoji: '🥐' },
  { prompt: 'A jellyfish disco', emoji: '🪩' },
  { prompt: 'The world’s happiest thunderstorm', emoji: '⛈️' },
  { prompt: 'A goat mountain-climbing champion', emoji: '🐐' },
  { prompt: 'The door to a tiny world under your bed', emoji: '🛏️' },
  { prompt: 'A parrot who repeats everything in colors', emoji: '🦜' },
  { prompt: 'The playground of your dreams', emoji: '🎠' },
  { prompt: 'A soup with an entire adventure inside', emoji: '🍜' },
  { prompt: 'An elephant painting with its trunk', emoji: '🐘' },
  { prompt: 'The night sky rearranged into new shapes', emoji: '✨' },
  { prompt: 'A frog prince who likes being a frog', emoji: '🐸' },
  { prompt: 'Your backpack if it could walk', emoji: '🎒' },
  { prompt: 'A lemonade stand on the moon', emoji: '🍋' },
  { prompt: 'The world’s coziest reading nook', emoji: '🕯️' },
  { prompt: 'A butterfly with stained-glass wings', emoji: '🦋' },
  { prompt: 'The monster under the bed’s day off', emoji: '🧦' },
  { prompt: 'A hedgehog’s balloon collection', emoji: '🦔' },
  { prompt: 'The train station for migrating birds', emoji: '🚉' },
  { prompt: 'A sandcastle with a working drawbridge', emoji: '🏰' },
];

// Large prime stride: consecutive days land far apart in the list, and because
// gcd(PRIME, length)=1 the full list cycles before any repeat.
const STRIDE = 61;

// UTC day number — the whole world flips to the new challenge together.
function dayNumber(date = new Date()) {
  return Math.floor(date.getTime() / 86_400_000);
}

export function dailyChallenge(date = new Date()) {
  const day = dayNumber(date);
  const pick = CHALLENGES[(day * STRIDE) % CHALLENGES.length];
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return {
    date: iso,
    prompt: pick.prompt,
    emoji: pick.emoji,
    tag: `daily-${iso}`,
    // When the next challenge lands (next UTC midnight).
    endsAt: (day + 1) * 86_400_000,
  };
}

export const _challengeCount = CHALLENGES.length;
