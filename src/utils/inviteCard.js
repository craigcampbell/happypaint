// "Come draw with me" invite card — a 1080×1080 PNG that bundles the room's
// current art with the room code + join link. Instagram has no web share URL
// and drops any text handed to it, so an IMAGE that carries the invite is the
// only thing that survives the trip; X gets the link via its intent URL and
// unfurls the /join OG card. Rendered once per share-sheet open, off-DOM.

export const INVITE_CARD_SIZE = 1080;

export function inviteCaption({ roomId, joinUrl }) {
  return `Come draw with me on Drawesome! 🎨 Room code ${roomId} — join at ${joinUrl}`;
}

export function xIntentUrl({ roomId, joinUrl }) {
  const text = `Come draw with me on Drawesome! 🎨 Room code ${roomId}`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(joinUrl)}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts?.load('700 72px "Fredoka Variable"'),
      document.fonts?.load('700 40px "Nunito Sans Variable"'),
    ]);
  } catch {
    // Fall back to the system stack — the card still reads fine.
  }
}

const DISPLAY = '"Fredoka Variable", "Arial Rounded MT Bold", ui-rounded, system-ui, sans-serif';
const BODY = '"Nunito Sans Variable", ui-rounded, system-ui, sans-serif';

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.art  flattened room art (any aspect; fitted)
 * @param {string} opts.roomId
 * @param {string} opts.joinUrl
 * @param {string} [opts.title]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderInviteCard({ art, roomId, joinUrl, title }) {
  await ensureFonts();
  const S = INVITE_CARD_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");

  // Backdrop: soft brand gradient + a few confetti dots.
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, "#f3e8ff");
  bg.addColorStop(0.55, "#ffe4f1");
  bg.addColorStop(1, "#fff1d6");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  const dots = ["#c084fc", "#f472b6", "#fbbf24", "#34d399", "#60a5fa"];
  for (let i = 0; i < 26; i += 1) {
    const x = ((i * 397) % 1013) + 30;
    const y = ((i * 251) % 1013) + 30;
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = dots[i % dots.length];
    ctx.beginPath();
    ctx.arc(x, y, 8 + (i % 4) * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Headline.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#3b1d5e";
  ctx.font = `700 76px ${DISPLAY}`;
  ctx.fillText("Come draw with me! 🎨", S / 2, 132);

  // Art frame: fit the art into an 896×560 box (canvas aspect is 1.6).
  const boxW = 896;
  const boxH = 560;
  const boxX = (S - boxW) / 2;
  const boxY = 180;
  ctx.save();
  ctx.shadowColor = "rgba(59, 29, 94, 0.28)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, boxX - 14, boxY - 14, boxW + 28, boxH + 28, 32);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, boxX, boxY, boxW, boxH, 22);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  if (art && art.width > 0 && art.height > 0) {
    const scale = Math.min(boxW / art.width, boxH / art.height);
    const w = art.width * scale;
    const h = art.height * scale;
    ctx.drawImage(art, boxX + (boxW - w) / 2, boxY + (boxH - h) / 2, w, h);
  }
  ctx.restore();

  // Room title (optional, single line, trimmed).
  let y = boxY + boxH + 50;
  if (title) {
    ctx.fillStyle = "#5b3a86";
    ctx.font = `700 38px ${BODY}`;
    let label = String(title).trim();
    while (label.length > 3 && ctx.measureText(label).width > 900) label = `${label.slice(0, -2).trimEnd()}…`;
    ctx.fillText(label, S / 2, y);
    y += 42;
  }

  // Room-code pill.
  const pillW = 620;
  const pillH = 100;
  const pillX = (S - pillW) / 2;
  const pillY = y - 10;
  ctx.fillStyle = "#3b1d5e";
  roundRect(ctx, pillX, pillY, pillW, pillH, 54);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 34px ${BODY}`;
  ctx.textAlign = "left";
  ctx.fillText("ROOM CODE", pillX + 44, pillY + 62);
  ctx.font = `700 58px ${DISPLAY}`;
  ctx.textAlign = "right";
  ctx.fillText(String(roomId), pillX + pillW - 44, pillY + 70);

  // Join link + brand.
  ctx.textAlign = "center";
  ctx.fillStyle = "#3b1d5e";
  ctx.font = `700 38px ${BODY}`;
  ctx.fillText(joinUrl.replace(/^https?:\/\//, ""), S / 2, pillY + pillH + 62);
  ctx.fillStyle = "#7c3aed";
  ctx.font = `700 30px ${BODY}`;
  ctx.fillText("Free · no account needed · drawesome.art", S / 2, S - 40);

  return canvas;
}
