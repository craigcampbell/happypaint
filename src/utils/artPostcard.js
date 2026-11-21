// Print-sized 6 × 4 inch postcard. The file carries only the painting and
// the chosen note, never the room code, room link or participant identities.
export const POSTCARD_STYLES = {
  airmail: { name: "Air mail", ink: "#17394c", accent: "#bc4b3c", paper: "#fff6df", stamp: "#b5d7d2" },
  wildflower: { name: "Wildflower", ink: "#39553e", accent: "#905580", paper: "#fcf5e7", stamp: "#ecd5de" },
};

function drawStamp(ctx, style, floral) {
  ctx.save();
  ctx.translate(1484, 100);
  ctx.rotate(0.045);
  ctx.fillStyle = style.ink;
  ctx.fillRect(0, 0, 218, 264);
  ctx.fillStyle = style.stamp;
  ctx.fillRect(14, 14, 190, 236);
  // Center each perforation on the outer edge of the paper stamp.
  ctx.fillStyle = style.paper;
  ctx.beginPath();
  for (let x = 9; x < 218; x += 17) {
    for (const y of [0, 264]) {
      ctx.moveTo(x + 5, y); ctx.arc(x, y, 5, 0, 2 * Math.PI);
    }
  }
  for (let y = 9; y < 264; y += 17) {
    for (const x of [0, 218]) {
      ctx.moveTo(x + 5, y); ctx.arc(x, y, 5, 0, 2 * Math.PI);
    }
  }
  ctx.fill();
  ctx.fillStyle = style.accent;
  if (floral) {
    for (let i = 0; i < 8; i++) {
      ctx.save();
      ctx.translate(108, 111); ctx.rotate(i * Math.PI / 4);
      ctx.beginPath(); ctx.ellipse(0, -33, 18, 38, 0, 0, 2 * Math.PI); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = "#ffdb70";
    ctx.beginPath(); ctx.arc(108, 111, 25, 0, 2 * Math.PI); ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(110, 106, 46, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = style.ink; ctx.lineWidth = 6;
    for (let y = 138; y < 185; y += 16) {
      ctx.beginPath(); ctx.moveTo(32, y);
      ctx.bezierCurveTo(62, y - 20, 105, y + 17, 143, y);
      ctx.quadraticCurveTo(169, y - 10, 186, y); ctx.stroke();
    }
  }
  ctx.fillStyle = style.ink;
  ctx.font = '800 25px "DM Sans", sans-serif';
  ctx.textAlign = "center"; ctx.fillText("ART POST", 109, 224);
  ctx.restore();
}

function wrapParagraph(ctx, text, width) {
  const lines = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u)) {
    if (line && ctx.measureText(line + " " + word).width <= width) {
      line += " " + word;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (ctx.measureText(line).width <= width) continue;
    // Keep family emoji and combining accents together when a word or a
    // line of unspaced text needs to break across the postcard.
    const letters = typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word), part => part.segment)
      : Array.from(word);
    line = "";
    for (const letter of letters) {
      if (line && ctx.measureText(line + letter).width > width) {
        lines.push(line);
        line = "";
      }
      line += letter;
    }
  }
  lines.push(line);
  return lines;
}

export function renderArtPostcard({ art, note, styleId, date }) {
  const style = POSTCARD_STYLES[styleId];
  const card = document.createElement("canvas");
  card.width = 1800; card.height = 1200;
  const ctx = card.getContext("2d");
  ctx.fillStyle = style.paper;
  ctx.fillRect(0, 0, card.width, card.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, card.width, card.height);
  ctx.rect(17, 17, card.width - 34, card.height - 34);
  ctx.clip("evenodd");
  for (let x = -card.height; x < card.width; x += 100) {
    for (const [offset, color] of [[0, style.accent], [49, style.ink]]) {
      ctx.strokeStyle = color; ctx.lineWidth = 19;
      ctx.beginPath(); ctx.moveTo(x + offset, 0);
      ctx.lineTo(x + offset + card.height, card.height); ctx.stroke();
    }
  }
  ctx.restore();

  // Fit the complete original composition, including its outermost strokes.
  const ratio = Math.min(1368 / art.width, 855 / art.height);
  const width = art.width * ratio, height = art.height * ratio;
  const x = 65 + (1368 - width) / 2, y = 67 + (855 - height) / 2;
  ctx.fillStyle = style.ink;
  ctx.fillRect(x - 2, y - 2, width + 4, height + 4);
  ctx.drawImage(art, x, y, width, height);
  drawStamp(ctx, style, styleId === "wildflower");

  ctx.save();
  ctx.translate(1635, 927); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = style.ink;
  ctx.font = '800 92px "Bricolage Grotesque", sans-serif';
  ctx.fillText("Drawesome", 0, 0);
  ctx.font = '600 23px "DM Sans", sans-serif';
  ctx.fillText(date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }), 4, 43);
  ctx.restore();

  ctx.strokeStyle = style.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(65, 965); ctx.lineTo(1735, 965); ctx.stroke();
  ctx.fillStyle = style.ink;
  const message = note.trim() || "Made together.";
  let size = 67, lines;
  do {
    ctx.font = `600 ${size}px "Sketchbook lettering", cursive`;
    lines = message.split("\n").flatMap(paragraph => wrapParagraph(ctx, paragraph, 1650));
    if (lines.length * size * 1.1 <= 158) break;
    size -= 3;
  } while (size > 25);
  const leading = size * 1.1;
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => ctx.fillText(line, 68, 1061 + (i - (lines.length - 1) / 2) * leading));
  return card;
}
