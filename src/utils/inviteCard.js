// "Come draw with me" invite card — a 1080×1080 PNG that bundles the room's
// current art with the room code + join link. Instagram has no web share URL
// and drops any text handed to it, so an IMAGE that carries the invite is the
// only thing that survives the trip; X gets the link via its intent URL and
// unfurls the /join OG card. Rendered once per share-sheet open, off-DOM.
//
// Two themes:
//   classic  — the original pastel confetti card (year-round default outside
//              the Inktober season).
//   inktober — the seasonal card: original rough black-ink strokes, splatters
//              and cream paper, hand-lettered with the bundled Caveat face
//              (SIL OFL, public/fonts/caveat/OFL.txt) to match the homepage
//              Inktober hero. Every mark is drawn procedurally here — seeded,
//              jittered strokes and the site's own hand-authored splatter
//              paths — no artist's work is imitated. The drawing itself is
//              letterboxed whole and NOTHING is painted over it: frame,
//              banner and splatters all live in the margins.

export const INVITE_CARD_SIZE = 1080;

export function inviteCaption({ roomId, joinUrl, theme }) {
  const flair = theme === "inktober" ? " 🖋 #inktober" : " 🎨";
  return `Come draw with me on Drawesome!${flair} Room code ${roomId} — join at ${joinUrl}`;
}

export function xIntentUrl({ roomId, joinUrl, theme }) {
  const tag = theme === "inktober" ? " #inktober" : "";
  const text = `Come draw with me on Drawesome! 🎨 Room code ${roomId}${tag}`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(joinUrl)}`;
}

// A sketchbook page pinned to a fixed Inktober day (ShareInviteSheet's
// optional inktoberPage prop — { year, day, prompt }). Returns an
// /api/inktober-shaped payload with phase "active" so the sheet defaults to
// the Inktober theme and the card stamps its DAY chip for THAT page even
// after October ends, or null when the metadata is missing/invalid — the
// live event state then wins, exactly like an unpinned sheet.
export function pinnedInktoberState(page) {
  if (!page || typeof page !== "object" || Array.isArray(page)) return null;
  const day = Number(page.day);
  const year = Number(page.year);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  const prompt = typeof page.prompt === "string" && page.prompt.trim() ? page.prompt.trim() : null;
  return {
    phase: "active",
    day,
    year,
    prompt,
    date: `${year}-10-${String(day).padStart(2, "0")}`,
    nextChangeAt: null,
    pinned: true,
  };
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

// The Inktober lettering face is bundled locally (the homepage loads it as
// "Inktober Ink" via home-inktober.css, but the studio never imports that
// stylesheet) — register it here under our own family name so card rendering
// is self-contained no matter which route the share sheet opens on.
let inkFontPromise = null;
function ensureInkFont() {
  if (!inkFontPromise) {
    inkFontPromise = (async () => {
      try {
        if (typeof FontFace === "undefined" || !document.fonts) return false;
        const face = new FontFace(
          "Inktober Share Ink",
          'url("/fonts/caveat/Caveat-latin.woff2") format("woff2")',
          { weight: "400 700", style: "normal" },
        );
        await face.load();
        document.fonts.add(face);
        return true;
      } catch {
        return false; // cursive/system fallback — the card still reads fine.
      }
    })();
  }
  return inkFontPromise;
}

const DISPLAY = '"Fredoka Variable", "Arial Rounded MT Bold", ui-rounded, system-ui, sans-serif';
const BODY = '"Nunito Sans Variable", ui-rounded, system-ui, sans-serif';
const INK_FONT = '"Inktober Share Ink", "Inktober Ink", Caveat, "Segoe Script", cursive';

// Truncate a single-line label to fit maxWidth with an ellipsis.
export function fitLabel(ctx, text, maxWidth) {
  let label = String(text).trim();
  while (label.length > 3 && ctx.measureText(label).width > maxWidth) label = `${label.slice(0, -2).trimEnd()}…`;
  return label;
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.art  flattened room art (any aspect; fitted)
 * @param {string} opts.roomId
 * @param {string} opts.joinUrl
 * @param {string} [opts.title]
 * @param {string} [opts.theme]  "classic" (default) | "inktober"
 * @param {object} [opts.inktober]  /api/inktober payload ({ phase, day, … })
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderInviteCard({ art, roomId, joinUrl, title, theme, inktober }) {
  if (theme === "inktober") {
    return renderInktoberCard({ art, roomId, joinUrl, title, inktober });
  }
  return renderClassicCard({ art, roomId, joinUrl, title });
}

async function renderClassicCard({ art, roomId, joinUrl, title }) {
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
    ctx.fillText(fitLabel(ctx, title, 900), S / 2, y);
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

/* ------------------------------------------------------------------------ */
/* Inktober: cream paper, rough original black-ink strokes, Caveat lettering */
/* ------------------------------------------------------------------------ */

const INK = "#17131f";
const PAPER = "#fbf3df";
const PANEL = "#fffdf8";
const MUTED = "#655d71";

// Deterministic per-room PRNG so each card's hand-made marks are stable.
function hashSeed(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A wobbly hand-drawn stroke between two points: jittered polyline, round
// caps, slightly uneven along its length.
function roughLine(ctx, rand, x1, y1, x2, y2, { width = 4, wobble = 3, segments = 14 } = {}) {
  ctx.beginPath();
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const nx = x1 + (x2 - x1) * t + (rand() - 0.5) * 2 * wobble;
    const ny = y1 + (y2 - y1) * t + (rand() - 0.5) * 2 * wobble;
    if (i === 0) ctx.moveTo(nx, ny);
    else ctx.lineTo(nx, ny);
  }
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function roughRectStroke(ctx, rand, x, y, w, h, opts = {}) {
  roughLine(ctx, rand, x, y, x + w, y, { segments: 30, ...opts });
  roughLine(ctx, rand, x + w, y, x + w, y + h, { segments: 30, ...opts });
  roughLine(ctx, rand, x + w, y + h, x, y + h, { segments: 30, ...opts });
  roughLine(ctx, rand, x, y + h, x, y, { segments: 30, ...opts });
}

// Hand-authored ink pools, flicks and splash crowns — the site's own original
// marks, shared with the homepage Inktober hero (InktoberInkHeading.jsx) so
// the card and the homepage read as one event. Drawn in an 80×60 box.
const SPLATTERS = {
  a: "M32 26c8-9 24-7 28 3 3 8-3 15-11 16-9 2-19-2-21-10-1-4 1-7 4-9zM62 14c3-3 8-2 9 2 1 3-2 6-5 6-4 0-6-4-4-8zM14 38c2-3 7-3 8 0 1 4-3 7-6 5-3-1-4-3-2-5zM70 34c4-1 7 2 6 6-1 3-6 4-8 1-2-2-1-6 2-7z",
  b: "M8 30c16-10 34-16 52-18 4-1 7 1 6 4-1 2-4 3-8 4-16 4-32 10-46 18-3 2-6-2-4-8zM64 30c3-2 7 0 7 4 0 3-4 5-7 4-3-2-3-6 0-8zM20 44c2-2 6-1 6 2 1 3-3 5-5 4-2-1-3-4-1-6z",
  c: "M40 38c-6-2-9-8-6-13l7 4 3-12 6 10 7-8 2 12 10-4-5 10c3 6-3 12-11 12-5 0-10-4-13-11zM18 18c2-3 7-3 8 0 1 4-3 7-6 6-3-1-4-4-2-6zM66 12c3-2 7 0 7 4-1 3-5 4-8 2-2-2-2-5 1-6z",
};

function drawSplatter(ctx, variant, x, y, scale, rotate) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotate);
  ctx.scale(scale, scale);
  ctx.fillStyle = INK;
  ctx.fill(new Path2D(SPLATTERS[variant] || SPLATTERS.a));
  ctx.restore();
}

// A hand-inked tag: tilted Caveat text with a rough underline swipe.
function inkTag(ctx, rand, text, cx, baseline, size, rotate) {
  ctx.save();
  ctx.translate(cx, baseline);
  ctx.rotate(rotate);
  ctx.fillStyle = INK;
  ctx.font = `700 ${size}px ${INK_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, 0, 0);
  const w = ctx.measureText(text).width;
  ctx.strokeStyle = INK;
  roughLine(ctx, rand, -w * 0.46, size * 0.22, w * 0.46, size * 0.16, { width: Math.max(3, size * 0.055), wobble: 2.6, segments: 10 });
  ctx.restore();
}

async function renderInktoberCard({ art, roomId, joinUrl, title, inktober }) {
  await Promise.all([ensureFonts(), ensureInkFont()]);
  const S = INVITE_CARD_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  const rand = mulberry32(hashSeed(`${roomId}:${joinUrl}`));

  // Cream paper with a soft vignette and faint fibre speckles.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, S, S);
  const vignette = ctx.createRadialGradient(S / 2, S * 0.42, S * 0.3, S / 2, S / 2, S * 0.78);
  vignette.addColorStop(0, "rgba(23, 19, 31, 0)");
  vignette.addColorStop(1, "rgba(23, 19, 31, 0.07)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 140; i += 1) {
    ctx.globalAlpha = 0.04 + rand() * 0.05;
    ctx.fillStyle = rand() > 0.5 ? "#b8a06a" : "#8a7a5c";
    ctx.beginPath();
    ctx.arc(rand() * S, rand() * S, 0.8 + rand() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Double rough ink border — the outer stroke bold, the inner a hairline,
  // like a twice-inked plate mark.
  ctx.strokeStyle = INK;
  roughRectStroke(ctx, rand, 30, 30, S - 60, S - 60, { width: 5, wobble: 2.4 });
  roughRectStroke(ctx, rand, 45, 45, S - 90, S - 90, { width: 2, wobble: 3 });

  // Splatter accents, margins only — never over the art panel below.
  drawSplatter(ctx, "c", 40, 34, 1.5, -0.24);
  drawSplatter(ctx, "b", S - 178, 118, 1.45, 0.42);
  drawSplatter(ctx, "a", 34, S - 176, 1.4, 2.6);
  drawSplatter(ctx, "a", S - 152, S - 158, 1.2, 1.1);

  // Headline, hand-tilted.
  ctx.save();
  ctx.translate(S / 2, 126);
  ctx.rotate(-0.027);
  ctx.fillStyle = INK;
  ctx.font = `700 92px ${INK_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fitLabel(ctx, "Come draw with me!", 880), 0, 0);
  ctx.restore();

  // The #inktober tag with its own underline swipe.
  inkTag(ctx, rand, "#inktober", S / 2 - 30, 196, 60, 0.021);

  // Day chip, stamped top-right like the homepage card (only mid-event).
  if (inktober?.phase === "active" && Number.isInteger(inktober.day)) {
    ctx.save();
    ctx.translate(S - 158, 78);
    ctx.rotate(0.035);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    roundRect(ctx, -76, -26, 152, 52, 26);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = `800 27px ${BODY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`DAY ${inktober.day}`, 0, 2);
    ctx.restore();
  }

  // Art panel: a white sheet with a rough ink frame drawn AROUND it. The art
  // is letterboxed whole inside — nothing crosses onto the drawing.
  const boxW = 924;
  const boxH = 560;
  const boxX = (S - boxW) / 2;
  const boxY = 222;
  ctx.save();
  ctx.shadowColor = "rgba(23, 19, 31, 0.25)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = PANEL;
  roundRect(ctx, boxX, boxY, boxW, boxH, 16);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, boxX, boxY, boxW, boxH, 16);
  ctx.clip();
  ctx.fillStyle = PANEL;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  if (art && art.width > 0 && art.height > 0) {
    const pad = 18;
    const scale = Math.min((boxW - pad * 2) / art.width, (boxH - pad * 2) / art.height);
    const w = art.width * scale;
    const h = art.height * scale;
    ctx.drawImage(art, boxX + (boxW - w) / 2, boxY + (boxH - h) / 2, w, h);
  }
  ctx.restore();

  ctx.strokeStyle = INK;
  roughRectStroke(ctx, rand, boxX - 9, boxY - 9, boxW + 18, boxH + 18, { width: 4.5, wobble: 2.2 });

  // Room title in hand lettering (optional, trimmed to the card).
  let y = boxY + boxH + 62;
  if (title) {
    ctx.fillStyle = INK;
    ctx.font = `600 46px ${INK_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitLabel(ctx, title, 880), S / 2, y);
    y += 50;
  } else {
    y += 8;
  }

  // Room-code plate: hand-ruled double stroke, letterspaced Caveat code.
  const pillW = 640;
  const pillH = 100;
  const pillX = (S - pillW) / 2;
  const pillY = y - 6;
  ctx.strokeStyle = INK;
  roughRectStroke(ctx, rand, pillX, pillY, pillW, pillH, { width: 4.5, wobble: 2 });
  roughRectStroke(ctx, rand, pillX + 7, pillY + 7, pillW - 14, pillH - 14, { width: 1.6, wobble: 2.4 });
  ctx.fillStyle = MUTED;
  ctx.font = `800 26px ${BODY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("ROOM CODE", pillX + 40, pillY + 60);
  ctx.fillStyle = INK;
  ctx.font = `700 62px ${INK_FONT}`;
  ctx.textAlign = "right";
  try { ctx.letterSpacing = "5px"; } catch { /* older canvas */ }
  ctx.fillText(String(roomId), pillX + pillW - 38, pillY + 70);
  try { ctx.letterSpacing = "0px"; } catch { /* older canvas */ }

  // Join link + brand mark.
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = `700 34px ${BODY}`;
  ctx.fillText(joinUrl.replace(/^https?:\/\//, ""), S / 2, pillY + pillH + 56);
  ctx.fillStyle = MUTED;
  ctx.font = `700 26px ${BODY}`;
  ctx.fillText("Free · no account needed · drawesome.art", S / 2, S - 62);

  return canvas;
}
