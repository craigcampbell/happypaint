const FALLBACK_PALETTE = ["#cfd5da", "#8f9aa4", "#3f474e"];

const PREVIEW_THEMES = [
  {
    id: "space",
    label: "Space",
    asset: "/preview-themes/space.webp",
    codes: ["SPACE"],
    keywords: ["space", "galaxy", "planet", "rocket", "alien", "star"],
  },
  {
    id: "ocean",
    label: "Under the Sea",
    asset: "/preview-themes/ocean.webp",
    codes: ["OCEAN"],
    keywords: ["ocean", "under the sea", "underwater", "coral", "mermaid", "fish"],
  },
  {
    id: "dinosaurs",
    label: "Dino World",
    asset: "/preview-themes/dinosaurs.webp",
    codes: ["DINOS"],
    keywords: ["dino", "dinosaur", "t-rex", "triceratops", "prehistoric"],
  },
  {
    id: "castles",
    label: "Castles & Dragons",
    asset: "/preview-themes/castles.webp",
    codes: ["CASTLE"],
    keywords: ["castle", "dragon", "knight", "kingdom", "tower"],
  },
];

function channelToHex(channel) {
  return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0");
}

function toHex(red, green, blue) {
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

function colorDistance(first, second) {
  const red = first.red - second.red;
  const green = first.green - second.green;
  const blue = first.blue - second.blue;
  return Math.sqrt(red * red + green * green + blue * blue);
}

// Pull three useful, visually distinct colors from a tiny canvas sample. The
// source artwork may be 4000x2500, but this reads only 48x30 pixels and skips
// paper-white buckets, so opening the preview stays cheap even on tablets.
export function extractCanvasPalette(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 48;
  sample.height = 30;
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);

  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 160) {
      continue;
    }

    const rawRed = pixels[index];
    const rawGreen = pixels[index + 1];
    const rawBlue = pixels[index + 2];
    if (rawRed > 238 && rawGreen > 238 && rawBlue > 238) {
      continue;
    }

    const red = Math.min(255, Math.round(rawRed / 32) * 32);
    const green = Math.min(255, Math.round(rawGreen / 32) * 32);
    const blue = Math.min(255, Math.round(rawBlue / 32) * 32);
    const key = `${red}-${green}-${blue}`;
    const current = buckets.get(key) || { red, green, blue, count: 0, saturation: 0 };
    current.count += 1;
    current.saturation += Math.max(rawRed, rawGreen, rawBlue) - Math.min(rawRed, rawGreen, rawBlue);
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()].sort((first, second) => {
    const firstScore = first.count * (1 + first.saturation / Math.max(1, first.count) / 255);
    const secondScore = second.count * (1 + second.saturation / Math.max(1, second.count) / 255);
    return secondScore - firstScore;
  });

  const selected = [];
  for (const color of ranked) {
    if (selected.every((picked) => colorDistance(color, picked) >= 72)) {
      selected.push(color);
    }
    if (selected.length === 3) {
      break;
    }
  }

  // Put the most colorful sampled bucket first. It becomes the generic
  // preview's base color, while neutrals still make useful secondary shadows.
  selected.sort((first, second) => {
    const firstChroma = Math.max(first.red, first.green, first.blue) - Math.min(first.red, first.green, first.blue);
    const secondChroma = Math.max(second.red, second.green, second.blue) - Math.min(second.red, second.green, second.blue);
    return secondChroma - firstChroma;
  });

  const palette = selected.map(({ red, green, blue }) => toHex(red, green, blue));
  for (const fallback of FALLBACK_PALETTE) {
    if (palette.length === 3) {
      break;
    }
    if (!palette.includes(fallback)) {
      palette.push(fallback);
    }
  }
  return palette;
}

export function resolvePreviewTheme({ roomId, roomTitle, roomPrompt }) {
  const code = String(roomId || "").toUpperCase();
  const searchable = `${roomTitle || ""} ${roomPrompt || ""}`.toLowerCase();
  return PREVIEW_THEMES.find(
    (theme) => theme.codes.includes(code) || theme.keywords.some((keyword) => searchable.includes(keyword)),
  ) || null;
}
