import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");
const mark = await readFile(path.join(publicDir, "brand-mark.svg"));

const icons = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];

await Promise.all(
  icons.map(([file, size]) =>
    sharp(mark, { density: 512 })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(path.join(publicDir, file)),
  ),
);

await sharp(path.join(publicDir, "og-card.svg"), { density: 192 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(path.join(publicDir, "og-image.png"));

console.log("Rendered Drawesome app icons and social share card.");
