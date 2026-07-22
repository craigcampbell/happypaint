// Word bank for Draw & Guess. Kid-friendly, concrete, drawable nouns grouped by
// rough difficulty so a round can pick an age-appropriate prompt. No proper
// nouns, brands, or anything that needs spelling gymnastics.

export const WORD_BANK = {
  easy: [
    'cat', 'dog', 'sun', 'moon', 'star', 'tree', 'fish', 'house', 'car', 'ball',
    'apple', 'banana', 'hat', 'cup', 'book', 'boat', 'duck', 'frog', 'bee', 'ant',
    'egg', 'cake', 'flower', 'cloud', 'rain', 'snow', 'shoe', 'sock', 'key', 'bed',
    'door', 'kite', 'drum', 'bell', 'leaf', 'bone', 'milk', 'pig', 'cow', 'owl',
    'bird', 'bug', 'box', 'fox', 'ice', 'jam', 'map', 'net', 'pen', 'pie',
  ],
  medium: [
    'rocket', 'dragon', 'castle', 'rainbow', 'pizza', 'robot', 'guitar', 'pirate',
    'octopus', 'penguin', 'dolphin', 'butterfly', 'elephant', 'giraffe', 'monkey',
    'spider', 'snail', 'turtle', 'rabbit', 'hedgehog', 'unicorn', 'mermaid',
    'wizard', 'ghost', 'pumpkin', 'snowman', 'igloo', 'volcano', 'island', 'bridge',
    'train', 'airplane', 'bicycle', 'balloon', 'umbrella', 'lighthouse', 'windmill',
    'campfire', 'treasure', 'crown', 'sword', 'shield', 'ladder', 'anchor', 'compass',
    'cactus', 'mushroom', 'strawberry', 'watermelon', 'ice cream', 'cupcake',
    'sandwich', 'popcorn', 'donut', 'lollipop', 'teapot', 'clock', 'lamp', 'camera',
  ],
  hard: [
    'astronaut', 'dinosaur', 'skeleton', 'scarecrow', 'jellyfish', 'seahorse',
    'chameleon', 'kangaroo', 'flamingo', 'peacock', 'raccoon', 'squirrel',
    'helicopter', 'submarine', 'telescope', 'microscope', 'skateboard', 'trampoline',
    'waterfall', 'tornado', 'galaxy', 'planet', 'satellite', 'fireworks',
    'roller coaster', 'ferris wheel', 'lighthouse keeper', 'treasure map',
    'haunted house', 'magic carpet', 'crystal ball', 'flying saucer', 'time machine',
    'birthday party', 'sand castle', 'snow globe', 'hot air balloon', 'shooting star',
  ],
};

// Weighted pick: mostly easy/medium so most kids can guess, some hard for spice.
// `rand` is injected (server passes Math.random) to keep this module pure-ish.
export function pickWord(rand = Math.random) {
  const roll = rand();
  const pool = roll < 0.45 ? WORD_BANK.easy : roll < 0.85 ? WORD_BANK.medium : WORD_BANK.hard;
  return pool[Math.floor(rand() * pool.length)];
}

// Offer the drawer a small choice so they aren't stuck with a word they can't
// draw — three distinct words from mixed difficulty.
export function pickWordChoices(rand = Math.random, n = 3) {
  const chosen = new Set();
  let guard = 0;
  while (chosen.size < n && guard < 50) {
    chosen.add(pickWord(rand));
    guard += 1;
  }
  return [...chosen];
}
