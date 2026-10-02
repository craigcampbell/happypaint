// "Come draw with me" invite card, a 1080×1080 PNG that bundles the room's
// current art with the room code + join link. Instagram has no web share URL
// and drops any text handed to it, so an IMAGE that carries the invite is the
// only thing that survives the trip; X gets the link via its intent URL and
// unfurls the /join OG card. Rendered once per share-sheet open, off-DOM.
//
// Two themes:
//   classic, the original pastel confetti card (year-round default outside
//              the Inktober season).
//   inktober, the seasonal card: an original HEAVY-INK treatment, layered
//              brushed contours, cross-hatched corner wedges, spatter, drips
//              and pooling blobs on cream paper, hand-lettered with the
//              bundled Caveat face (SIL OFL, public/fonts/caveat/OFL.txt) to
//              match the homepage Inktober hero. Every mark is drawn
//              procedurally here, seeded, width-profiled strokes and the
//              site's own hand-authored splatter paths, the conventions of
//              aggressive ink work as a genre, no artist's work imitated.
//              The drawing itself is letterboxed whole and NOTHING is painted
//              over it: frame, banner and splatters all live in the margins.

export const INVITE_CARD_SIZE = 1080;

export function inviteCaption({ roomId, joinUrl, theme }) {
  const flair = theme === "inktober" ? " 🖋 #inktober" : " 🎨";
  return `Come draw with me on Drawesome!${flair} Room code ${roomId}, join at ${joinUrl}`;
}

export function xIntentUrl({ roomId, joinUrl, theme }) {
  const tag = theme === "inktober" ? " #inktober" : "";
  const text = `Come draw with me on Drawesome! 🎨 Room code ${roomId}${tag}`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(joinUrl)}`;
}

// A sketchbook page pinned to a fixed Inktober day (ShareInviteSheet's
// optional inktoberPage prop, { year, day, prompt }). Returns an
// /api/inktober-shaped payload with phase "active" so the sheet defaults to
// the Inktober theme and the card stamps its DAY chip for THAT page even
// after October ends, or null when the metadata is missing/invalid, the
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
    // Fall back to the system stack, the card still reads fine.
  }
}

// The Inktober lettering face is bundled locally (the homepage loads it as
// "Inktober Ink" via home-inktober.css, but the studio never imports that
// stylesheet), register it here under our own family name so card rendering
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
        return false; // cursive/system fallback, the card still reads fine.
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
/* Inktober: HEAVY INK, brushed contours, hatching, spatter, drips, pools   */
/* on cream paper, Caveat lettering. The PRNG, stroke and splatter helpers   */
/* below are exported as pure geometry utilities so they can be unit-tested */
/* in Node (an OffscreenCanvas-less environment): they never touch the DOM. */
/* ------------------------------------------------------------------------ */

const INK = "#17131f";
const PAPER = "#fbf3df";
const PANEL = "#fffdf8";
const MUTED = "#655d71";
const FRAME_MARGIN = 30; // the heavy frame's inset from the card edge

// Deterministic per-room PRNG so each card's hand-made marks are stable:
// FNV-1a over the room id + join URL + (when pinned) day/prompt, so the same
// page always renders the identical card.
export function hashSeed(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The width a pen stroke has along its length: eases in and out of its max,
// then rides a fast oscillator (a quivering nib) plus a slow one (hand
// pressure). `o` is the roughness 0..1, heavier ink wobbles more.
export function brushWidth(t, o = 0.5, rand) {
  const edge = Math.min(1, Math.min(t, 1 - t) * 6 + 0.18);
  const nib = 1 + Math.sin(t * 41) * 0.14 * o;
  const pressure = 1 + Math.sin(t * 5.3) * 0.32 * o;
  const grit = rand ? 1 + (rand() - 0.5) * 0.5 * o : 1;
  return edge * nib * pressure * grit;
}

/**
 * A brushed ink stroke between two points, built as two offset pen passes
 * (a wet deposit and a dry scratchy one) so edges bleed and break like real
 * ink. Pure geometry: returns the spine, the ink quads and the dry pass.
 */
export function buildBrushStroke(x1, y1, x2, y2, rand, opts = {}) {
  const { width = 7, wobble = 3.4, segments = 18, offset = 0.72, o = 0.5 } = opts;
  // Centre spine of the stroke: a jittered polyline.
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    pts.push([
      x1 + (x2 - x1) * t + (rand() - 0.5) * 2 * wobble + Math.sin(t * 9 + 1) * wobble * 0.5 * o,
      y1 + (y2 - y1) * t + (rand() - 0.5) * 2 * wobble,
    ]);
  }
  // Each spine sample becomes a quad whose thickness follows the width
  // profile: the fill between consecutive quads is the ink deposit.
  const quads = [];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  let prevL = null;
  let prevR = null;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const w = (width * brushWidth(t, o, rand)) / 2;
    const [px, py] = pts[i];
    const l = [px + nx * w, py + ny * w];
    const r = [px - nx * w, py - ny * w];
    if (prevL && prevR && w > 0.15) {
      quads.push([prevL, prevR, r, l]);
    }
    prevL = l;
    prevR = r;
  }
  // The dry second pass: same spine, offset sideways, thinner, reads as
  // the scratchy nib edge that trails a fast stroke.
  const dryPts = pts.map(([px, py], i) => {
    const t = i / segments;
    const off = width * 0.5 * offset + Math.sin(t * 13) * width * 0.1 * o;
    return [px + nx * off, py + ny * off];
  });
  return { pts, quads, dryPts };
}

function paintBrushStroke(ctx, plan, { dryWidth = 2 } = {}) {
  for (const q of plan.quads) {
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    ctx.lineTo(q[1][0], q[1][1]);
    ctx.lineTo(q[2][0], q[2][1]);
    ctx.lineTo(q[3][0], q[3][1]);
    ctx.closePath();
    ctx.fill();
  }
  if (plan.dryPts.length > 1) {
    ctx.beginPath();
    plan.dryPts.forEach(([px, py], i) => {
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.lineWidth = dryWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

// A broken, skritchy contour: the stroke pauses and restarts, leaving gaps,
// like a pen running dry at speed.
export function buildBrokenContour(x1, y1, x2, y2, rand, opts = {}) {
  const { width = 8, o = 0.8, runs = 3 } = opts;
  const runsOut = [];
  for (let r = 0; r < runs; r += 1) {
    // Each run covers a random portion of the line, with breaks between.
    const a = rand() * 0.5;
    const b = Math.min(1, a + 0.25 + rand() * 0.6);
    const ax = x1 + (x2 - x1) * a;
    const ay = y1 + (y2 - y1) * a;
    const bx = x1 + (x2 - x1) * b;
    const by = y1 + (y2 - y1) * b;
    runsOut.push(buildBrushStroke(ax, ay, bx, by, rand, { width: width * (0.7 + rand() * 0.5), wobble: 4, o }));
  }
  return runsOut;
}

// A hand-drawn wobbly stroke between two points: jittered polyline, round
// caps, slightly uneven along its length (kept for the hairline details).
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

/**
 * Cross-hatch a corner wedge: two fans of scratched strokes starting on each
 * frame edge and running parallel to the OTHER edge (so the fans cross at
 * ~90°), with lengths that shrink away from the corner. Returns stroke
 * segments (pure geometry) for testing and for window clipping.
 */
export function buildHatchWedge(cx, cy, ax, ay, bx, by, rand, opts = {}) {
  const { lines = 9, span = 0.42, o = 0.9 } = opts;
  const segs = [];
  const elen = Math.hypot(ax - cx, ay - cy) || 1;
  const flen = Math.hypot(bx - cx, by - cy) || 1;
  const uax = (ax - cx) / elen;
  const uay = (ay - cy) / elen;
  const ubx = (bx - cx) / flen;
  const uby = (by - cy) / flen;
  for (let d = 0; d < 2; d += 1) {
    // d=0: starts on edge a, runs parallel to edge b; d=1: the converse.
    const ux = d === 0 ? uax : ubx;
    const uy = d === 0 ? uay : uby;
    const vx = d === 0 ? ubx : uax;
    const vy = d === 0 ? uby : uay;
    const edgeLen = d === 0 ? elen : flen;
    for (let i = 0; i < lines; i += 1) {
      const t = (i + 0.5) / lines; // position along the starting edge
      // Hatch length shrinks away from the corner.
      const maxLen = edgeLen * span * (1 - t * 0.82);
      const len = maxLen * (0.55 + rand() * 0.45);
      if (len < 3) continue;
      const sx = cx + ux * (edgeLen * t) + (rand() - 0.5) * 5;
      const sy = cy + uy * (edgeLen * t) + (rand() - 0.5) * 5;
      // Aim parallel to the other edge, with jitter so the weave scratches.
      const ang = Math.atan2(vy, vx) + (rand() - 0.5) * 0.4 * o;
      const ex2 = sx + Math.cos(ang) * len;
      const ey2 = sy + Math.sin(ang) * len;
      segs.push([sx, sy, ex2, ey2, 1 + rand() * 2.4]); // x1,y1,x2,y2,pen width
    }
  }
  return segs;
}

function paintHatchWedge(ctx, segs) {
  for (const [sx, sy, ex, ey, w] of segs) {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

/**
 * Spatter cluster: droplets flung outward from an origin with sizes that
 * decay with travel, plus a few elongated trails (streaks). Pure geometry.
 */
export function buildSpatterCluster(x, y, rand, opts = {}) {
  const { drops = 26, radius = 46, o = 1 } = opts;
  const out = [];
  for (let i = 0; i < drops; i += 1) {
    const ang = rand() * Math.PI * 2;
    const far = rand() * rand(); // biased toward the centre
    const dist = radius * (0.15 + far * 1.4);
    const size = (2.6 - far * 1.6) * (0.6 + rand() * 0.8);
    if (size <= 0.25) continue;
    const elong = rand() < 0.35 ? 2.8 + rand() * 4.2 : 1; // some droplets trail
    out.push([
      x + Math.cos(ang) * dist,
      y + Math.sin(ang) * dist,
      Math.max(0.3, size) * o,
      ang,
      elong,
    ]);
  }
  return out;
}

function paintSpatterCluster(ctx, drops) {
  for (const [px, py, size, ang, elong] of drops) {
    if (elong > 1.4) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.ellipse(0, 0, size * elong, size, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * An ink drip running down from (x, y): a bead head with a wavering tail
 * whose width tapers and pools slightly at the end. Pure geometry.
 */
export function buildDrip(x, y, rand, opts = {}) {
  const { len = 90, width = 7 } = opts;
  const tail = [];
  const segs = 8;
  const drift = (rand() - 0.5) * 26;
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    tail.push([
      x + drift * t * t + (rand() - 0.5) * 3,
      y + len * t,
      width * (1 - t * 0.72) * (0.8 + rand() * 0.3), // taper
    ]);
  }
  const bead = width * (0.9 + rand() * 0.5);
  return { tail, bead, endX: tail[segs][0], endY: tail[segs][1] };
}

function paintDrip(ctx, { tail, bead, endX, endY }) {
  // Per-segment lines whose width follows the taper, then a pooled bead.
  for (let i = 1; i < tail.length; i += 1) {
    const [ax, ay, aw] = tail[i - 1];
    const [bx, by, bw] = tail[i];
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = (aw + bw) / 2;
    ctx.lineCap = "round";
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(endX, endY + bead * 0.2, bead, 0, Math.PI * 2); // pool at the tip
  ctx.fill();
}

/**
 * A pooling ink blob: an irregular closed outline (radius perturbed by a
 * few sine harmonics) with a couple of satellite droplets.
 */
export function buildBlob(x, y, rand, opts = {}) {
  const { r = 26 } = opts;
  const h1 = 0.12 + rand() * 0.14;
  const h2 = 0.05 + rand() * 0.1;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const sat = [];
  const satCount = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < satCount; i += 1) {
    const ang = rand() * Math.PI * 2;
    const dist = r * (1.4 + rand() * 1.1);
    sat.push([x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, r * (0.1 + rand() * 0.14)]);
  }
  return { x, y, r, h1, h2, p1, p2, sat };
}

function blobPath({ x, y, r, h1, h2, p1, p2 }) {
  const path = new Path2D();
  const N = 26;
  for (let i = 0; i <= N; i += 1) {
    const a = (i / N) * Math.PI * 2;
    const rr = r * (1 + Math.sin(a * 3 + p1) * h1 + Math.sin(a * 7 + p2) * h2);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
  return path;
}

function paintBlob(ctx, blob) {
  ctx.fill(blobPath(blob));
  for (const [sx, sy, sr] of blob.sat) {
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Paper grain: an S×S sheet of subtle fibre noise, rendered ONCE per card
// into an offscreen canvas and blitted over the flat cream ground. Random
// values come from the seeded PRNG so the texture is deterministic too.
function makePaperTexture(S, rand) {
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const tctx = c.getContext("2d");
  const img = tctx.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 18;
    d[i] = 251 + n * 0.9;
    d[i + 1] = 243 + n;
    d[i + 2] = 223 + n * 0.8;
    d[i + 3] = 26 + (rand() < 0.06 ? 30 : 0);
  }
  tctx.putImageData(img, 0, 0);
  return c;
}

// Hand-authored ink pools, flicks and splash crowns, the site's own original
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

/**
 * Pre-render the FULL heavy-ink frame (border, corner hatching, spatter,
 * drips, blobs) into one offscreen layer with a transparent centre window,
 * so the room art is composited in one blit and nothing ever paints over it.
 * The window is `win` = { x, y, w, h } in card coordinates. Pure drawing on
 * top of the seeded PRNG, exported for headless testing.
 */
export function renderInkFrameLayer(S, win, rand) {
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  const M = FRAME_MARGIN;

  // 1. Layered rough border contours, two heavy wet passes per side (offset
  // and thinner than the first) plus a broken skritchy pass, so the frame
  // reads as repeatedly inked, not vector-clean.
  const borderRuns = [];
  const sides = [
    [M, M, S - M, M],
    [S - M, M, S - M, S - M],
    [S - M, S - M, M, S - M],
    [M, S - M, M, M],
  ];
  for (const [x1, y1, x2, y2] of sides) {
    borderRuns.push(buildBrushStroke(x1, y1, x2, y2, rand, { width: 16, wobble: 4.5, segments: 26, o: 0.9 }));
    borderRuns.push(
      buildBrushStroke(x1 + 7, y1 + 8, x2 + 5, y2 + 9, rand, { width: 9, wobble: 5.5, segments: 26, o: 1 }),
    );
    for (const plan of buildBrokenContour(x1 - 4, y1 - 5, x2 - 3, y2 - 4, rand, { width: 5, o: 1, runs: 2 })) {
      borderRuns.push(plan);
    }
  }
  for (const plan of borderRuns) {
    // Only keep the parts of each run outside the art window: clip per-quad
    // by just skipping quads whose centre is inside the window.
    const kept = plan.quads.filter(([a, b2, c2, d2]) => {
      const mx = (a[0] + b2[0] + c2[0] + d2[0]) / 4;
      const my = (a[1] + b2[1] + c2[1] + d2[1]) / 4;
      return !(mx > win.x && mx < win.x + win.w && my > win.y && my < win.y + win.h);
    });
    paintBrushStroke(ctx, { ...plan, quads: kept, dryPts: [] }, { dryWidth: 1.4 });
    // The dry scratch pass also stays out of the window.
    const dry = plan.dryPts.filter(([px, py]) => !(px > win.x && px < win.x + win.w && py > win.y && py < win.y + win.h));
    if (dry.length > 1) {
      ctx.beginPath();
      dry.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  // 2. Cross-hatched shadow wedges: BIG in the bottom corners, small in the
  // top corners (the banner band up there carries lettering).
  const bigCorner = S * 0.26;
  const smallCorner = S * 0.13;
  const corners = [
    [M, M, M + smallCorner, M, M, M + smallCorner],
    [S - M, M, S - M - smallCorner, M, S - M, M + smallCorner],
    [S - M, S - M, S - M - bigCorner, S - M, S - M, S - M - bigCorner],
    [M, S - M, M + bigCorner, S - M, M, S - M - bigCorner],
  ];
  for (const [cx, cy, ax, ay, bx, by] of corners) {
    paintHatchWedge(
      ctx,
      buildHatchWedge(cx, cy, ax, ay, bx, by, rand, { lines: 10, span: 0.55 }).filter(
        ([sx, sy, ex, ey]) =>
          !(
            sx > win.x &&
            sx < win.x + win.w &&
            sy > win.y &&
            sy < win.y + win.h &&
            ex > win.x &&
            ex < win.x + win.w &&
            ey > win.y &&
            ey < win.y + win.h
          ),
      ),
    );
  }

  // 3. Spatter clusters flung along the top border and down the side
  // margins, with a few long trails. Each drop is kept out of the window.
  const clusterSpots = [
    [S * 0.13, M + 28, 40],
    [S * 0.87, M + 32, 42],
    [M + 40, S * 0.5, 36],
    [S - M - 40, S * 0.52, 36],
    [M + 44, S * 0.68, 30],
    [S - M - 44, S * 0.7, 30],
  ];
  for (const [sx, sy, rad] of clusterSpots) {
    const drops = buildSpatterCluster(sx, sy, rand, { drops: 30, radius: rad }).filter(
      ([px, py]) => !(px > win.x && px < win.x + win.w && py > win.y && py < win.y + win.h),
    );
    paintSpatterCluster(ctx, drops);
  }

  // 4. Drips running down from the top edge of the frame (2-4 of them), in
  // the side margins so they never touch the art window or the headline.
  const margin = win.x - M; // side margin width available for ink
  const dripCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < dripCount; i += 1) {
    const side = i % 2 === 0 ? 1 : -1; // alternate left / right margin
    const anchor = side === 1 ? M + margin * (0.3 + rand() * 0.4) : S - M - margin * (0.3 + rand() * 0.4);
    paintDrip(ctx, buildDrip(anchor, M + 10, rand, { len: 90 + rand() * 110, width: 7 + rand() * 4 }));
  }

  // 5. Bold pooling blobs: one upper-left, one lower-right, plus a small one.
  paintBlob(ctx, buildBlob(M + 54, M + 62, rand, { r: 18 + rand() * 8 }));
  paintBlob(ctx, buildBlob(S - M - 90, S - M - 110, rand, { r: 22 + rand() * 8 }));
  paintBlob(ctx, buildBlob(S - M - 32, M + 80, rand, { r: 9 + rand() * 5 }));

  // 6. The hand-authored splash crowns as finishing flicks (margins only),
  // placed away from the room-code plate at the bottom centre.
  drawSplatter(ctx, "c", 100, S - 240, 1.25, -0.24);
  drawSplatter(ctx, "b", S - 92, S * 0.46, 1.2, 0.42);

  return c;
}

// A hand-inked tag: tilted heavy Caveat text with a spattered underline
// swipe, double-struck lettering plus droplets around the baseline.
function inkTag(ctx, rand, text, cx, baseline, size, rotate) {
  ctx.save();
  ctx.translate(cx, baseline);
  ctx.rotate(rotate);
  ctx.fillStyle = INK;
  ctx.font = `700 ${size}px ${INK_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, 0, 0);
  ctx.globalAlpha = 0.55; // second strike, nudged: double-inked weight
  ctx.fillText(text, 1.5, 1.5);
  ctx.globalAlpha = 1;
  const w = ctx.measureText(text).width;
  ctx.strokeStyle = INK;
  roughLine(ctx, rand, -w * 0.46, size * 0.22, w * 0.46, size * 0.16, { width: Math.max(4, size * 0.075), wobble: 2.6, segments: 10 });
  paintSpatterCluster(
    ctx,
    buildSpatterCluster(0, size * 0.18, rand, { drops: 12, radius: w * 0.5 }).filter(
      ([, py]) => py < size * 0.34, // keep droplets in the banner band, off the art
    ),
  );
  ctx.restore();
}

async function renderInktoberCard({ art, roomId, joinUrl, title, inktober }) {
  await Promise.all([ensureFonts(), ensureInkFont()]);
  const S = INVITE_CARD_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  const pinnedKey = inktober?.pinned ? `:${inktober.day}:${inktober.prompt ?? ""}` : "";
  const rand = mulberry32(hashSeed(`ink2:${roomId}:${joinUrl}${pinnedKey}`));

  // Cream paper ground + pre-rendered fibre/roughness noise (one offscreen
  // pass, drawn once), then the soft vignette on top.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(makePaperTexture(S, rand), 0, 0);
  const vignette = ctx.createRadialGradient(S / 2, S * 0.42, S * 0.3, S / 2, S / 2, S * 0.78);
  vignette.addColorStop(0, "rgba(23, 19, 31, 0)");
  vignette.addColorStop(1, "rgba(23, 19, 31, 0.07)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, S, S);

  // Headline, hand-tilted, double-struck. Sized so the DAY chip fits beside
  // it in the banner band without touching the lettering.
  ctx.save();
  ctx.translate(S / 2, 124);
  ctx.rotate(-0.027);
  ctx.fillStyle = INK;
  ctx.font = `700 84px ${INK_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const headline = fitLabel(ctx, "Come draw with me!", 760);
  ctx.fillText(headline, 0, 0);
  ctx.globalAlpha = 0.5;
  ctx.fillText(headline, 2, 2);
  ctx.restore();
  ctx.globalAlpha = 1;

  // Day chip + the #inktober mark + the pinned day/prompt line: the chip is
  // drawn AFTER the ink frame (below) so its white body stamps cleanly over
  // any corner hatching.
  const day = inktober?.phase === "active" && Number.isInteger(inktober.day) ? inktober.day : null;

  // #inktober tag row: the tag left of centre, the pinned day/prompt line
  // right of centre, and (between them, when no prompt) the DAY chip, all in
  // the banner band, clear of the headline above and the art panel below.
  const tagBaseline = 202;
  inkTag(ctx, rand, "#inktober", S / 2 - 240, tagBaseline, 62, 0.021);

  if (day !== null && inktober.prompt) {
    ctx.font = `700 42px ${INK_FONT}`; // measure at the size it will render
    inkTag(
      ctx,
      rand,
      fitLabel(ctx, `day ${day} - ${inktober.prompt}`, 320),
      S / 2 + 230,
      tagBaseline - 14,
      42,
      -0.02,
    );
  }

  // Art panel: a white sheet letterboxed whole, the heavy ink frame lives on
  // its own pre-rendered layer with a transparent window, composited AFTER
  // the art so frame, hatching, spatter, drips and blobs all sit around (and
  // grip the edges of) the drawing without ever covering it. 880 wide leaves
  // a real side margin (~85px) for drips and spatter.
  const boxW = 880;
  const boxH = 532;
  const boxX = (S - boxW) / 2;
  const boxY = 236;
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

  // The heavy-ink frame layer, one pre-render + one blit.
  ctx.drawImage(
    renderInkFrameLayer(S, { x: boxX - 14, y: boxY - 14, w: boxW + 28, h: boxH + 28 }, rand),
    0,
    0,
  );

  // Day chip, stamped AFTER the frame. With a pinned prompt it sits in the
  // inktober tag row's middle; otherwise right of centre in the band.
  if (day !== null) {
    const chipX = inktober.prompt ? S / 2 - 10 : S / 2 + 190;
    ctx.save();
    ctx.translate(chipX, 186);
    ctx.rotate(0.04);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4;
    roundRect(ctx, -58, -22, 116, 44, 22);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK;
    ctx.font = `800 24px ${BODY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`DAY ${day}`, 0, 1);
    ctx.restore();
  }

  // Bottom stack, laid out UP from the frame: brand line tucked just inside
  // the frame, join link above it, room plate above that, optional title
  // last, so nothing is ever struck through by the border stroke.
  const brandY = S - FRAME_MARGIN - 22;
  const linkY = brandY - 46;
  const plateH = 100;
  const plateY = linkY - 56 - plateH;
  let y = plateY - 22; // baseline for the optional title above the plate

  if (title) {
    ctx.fillStyle = INK;
    ctx.font = `600 46px ${INK_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitLabel(ctx, title, 880), S / 2, y);
  }

  // Room-code plate: hand-ruled double stroke, letterspaced Caveat code.
  const pillW = 640;
  const pillH = plateH;
  const pillX = (S - pillW) / 2;
  const pillY = plateY;
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
  ctx.fillText(joinUrl.replace(/^https?:\/\//, ""), S / 2, linkY);
  ctx.fillStyle = MUTED;
  ctx.font = `700 26px ${BODY}`;
  ctx.fillText("Free · no account needed · drawesome.art", S / 2, brandY);

  return canvas;
}
