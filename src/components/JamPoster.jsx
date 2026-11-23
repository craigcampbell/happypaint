// The homepage centrepiece: the headline is a coloring page, and a handful of
// painters color it in together while you watch. It is a real canvas, so a
// visitor can pick a marker and join in before they ever open a room.
//
// The painters are scripted demo bots and the caption says so (no invented
// people or live counts, see DESIGN-DIRECTION.md). The plan is seeded and
// replayable, which lets a resize fast-forward to the same moment and lets
// reduced-motion visitors and the Curator preview get the finished poster.

import { useEffect, useRef, useState } from 'react';
import './jam-poster.css';

const FONT = 'Anton, Impact, "Haettenschweiler", "Arial Narrow Bold", sans-serif';
const INK = '#181916';
const BOTS = [
  { name: 'Pip', tag: '#d93a22', inks: ['#e7472d', '#ff9f1c'] },
  { name: 'Fern', tag: '#16865a', inks: ['#22b07a', '#a4dd3c'] },
  { name: 'Momo', tag: '#2a62d6', inks: ['#3d8bf2', '#4fd4e6'] },
  { name: 'Zed', tag: '#a02fc4', inks: ['#ff5fa2', '#8f5bf0'] },
];
const VISITOR_INKS = [
  { name: 'Black', value: '#181916' },
  { name: 'Red', value: '#e7472d' },
  { name: 'Blue', value: '#3d8bf2' },
  { name: 'Pink', value: '#ff5fa2' },
];
// After the page's own headline, the poster keeps changing: each round the
// bots get a new line to color and a fresh batch of freestyle doodles.
const MORE_HEADLINES = [
  ['Make a mess', 'together.'],
  ['Doodle with', 'a friend.'],
  ['Paint one', 'big picture.'],
  ['Scribble', 'out loud.'],
];
const HOLD_MS = 9000;
const PACE = 1.75; // marker speed, in headline heights per second
const TRAVEL_BOOST = 2.6;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Phones get one or two short words per line so every line can be poster-sized.
function rowsFor(lines, narrow) {
  const upper = lines.map(line => line.toUpperCase().trim()).filter(Boolean);
  if (!narrow) return upper;
  const rows = [];
  for (const line of upper) {
    let row = '';
    for (const word of line.split(/\s+/)) {
      if (row && (row + ' ' + word).length > 8) { rows.push(row); row = word; }
      else row = row ? row + ' ' + word : word;
    }
    if (row) rows.push(row);
  }
  return rows;
}

function layout(ctx, lines, width, shrink = 1) {
  const narrow = width < 620;
  const rows = rowsFor(lines, narrow);
  const pad = Math.max(10, width * 0.025);
  const cap = width * (narrow ? 0.35 : 0.3);
  const placed = [];
  const glyphs = [];
  let y = 0;
  let sizes = 0;
  for (const text of rows) {
    ctx.font = `400 100px ${FONT}`;
    const size = Math.min(cap, ((width - pad * 2) / Math.max(1, ctx.measureText(text).width)) * 100) * shrink;
    ctx.font = `400 ${size}px ${FONT}`;
    const capHeight = ctx.measureText('H').actualBoundingBoxAscent || size * 0.73;
    if (!placed.length) y = size * 0.16;
    const baseline = y + capHeight;
    const rowWidth = ctx.measureText(text).width;
    placed.push({ text, size, x: pad, baseline, width: rowWidth, capHeight });
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === ' ') continue;
      const box = ctx.measureText(text[i]);
      const top = box.actualBoundingBoxAscent || capHeight;
      glyphs.push({
        x: pad + ctx.measureText(text.slice(0, i)).width,
        y: baseline - top,
        w: box.width,
        h: top + (box.actualBoundingBoxDescent || 0),
        size,
      });
    }
    sizes += size;
    y = baseline + size * 0.17;
  }
  const mean = sizes / Math.max(1, placed.length);
  return { rows: placed, glyphs, width, height: Math.ceil(y + mean * 0.2), mean, narrow };
}

function scribble(rect, brush, rand) {
  const points = [];
  const step = brush * 0.74;
  // Round caps reach exactly to the letter's own edge, never into a neighbour.
  const left = rect.x + brush * 0.5;
  const right = Math.max(left + 1, rect.x + rect.w - brush * 0.5);
  const count = Math.max(2, Math.ceil(rect.w / 13));
  let forward = rand() > 0.5;
  for (let y = rect.y + brush * 0.2; y < rect.y + rect.h + step * 0.4; y += step) {
    for (let i = 0; i <= count; i += 1) {
      const t = i / count;
      points.push([
        (forward ? left + (right - left) * t : right - (right - left) * t) + (rand() - 0.5) * 3,
        y + step * t + (rand() - 0.5) * brush * 0.22,
      ]);
    }
    forward = !forward;
  }
  return points;
}

// Other ways to color a letter in: up-and-down strokes, and slanted stripes
// that leave paper showing between them.
function scribbleTall(rect, brush, rand) {
  return scribble({ x: rect.y, y: rect.x, w: rect.h, h: rect.w }, brush, rand).map(([a, b]) => [b, a]);
}

function stripes(rect, brush, rand) {
  const points = [];
  const gap = brush * (1.7 + rand() * 0.5);
  let flip = false;
  for (let c = gap * 0.5; c < rect.w + rect.h; c += gap) {
    const a = [rect.x + Math.min(c, rect.w), rect.y + Math.max(0, c - rect.w)];
    const b = [rect.x + Math.max(0, c - rect.h), rect.y + Math.min(c, rect.h)];
    points.push(...(flip ? [b, a] : [a, b]));
    flip = !flip;
  }
  return points.length > 1 ? points : scribble(rect, brush, rand);
}

const FILLS = [scribble, scribble, scribble, scribbleTall, scribbleTall, stripes];

// A loose wandering line, different every time.
function wander(rand) {
  const points = [];
  let x = 0.1 + rand() * 0.2;
  let y = 0.3 + rand() * 0.4;
  let heading = rand() * Math.PI * 2;
  for (let i = 0; i < 46; i += 1) {
    points.push([x, y]);
    heading += (rand() - 0.5) * 1.5;
    x = Math.min(0.97, Math.max(0.03, x + Math.cos(heading) * 0.07));
    y = Math.min(0.97, Math.max(0.03, y + Math.sin(heading) * 0.07));
  }
  return [points];
}

// Small margin drawings, as unit-box strokes.
const DOODLES = [
  () => [Array.from({ length: 11 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    return [0.5 + Math.cos(angle) * 0.48, 0.52 + Math.sin(angle) * 0.48];
  }).filter((_, i) => i < 6)],
  () => [Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    return [0.5 + Math.cos(t * 5.2 * Math.PI) * 0.46 * t, 0.5 + Math.sin(t * 5.2 * Math.PI) * 0.46 * t];
  })],
  () => [Array.from({ length: 33 }, (_, i) => {
    const t = (i / 32) * Math.PI * 2;
    return [0.5 + 0.03 * 16 * Math.sin(t) ** 3, 0.47 - 0.03 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
  })],
  () => [
    Array.from({ length: 25 }, (_, i) => [0.5 + Math.cos((i / 24) * Math.PI * 2) * 0.24, 0.5 + Math.sin((i / 24) * Math.PI * 2) * 0.24]),
    ...Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2;
      return [[0.5 + Math.cos(angle) * 0.33, 0.5 + Math.sin(angle) * 0.33], [0.5 + Math.cos(angle) * 0.49, 0.5 + Math.sin(angle) * 0.49]];
    }),
  ],
  () => [
    Array.from({ length: 29 }, (_, i) => [0.5 + Math.cos((i / 28) * Math.PI * 2) * 0.46, 0.5 + Math.sin((i / 28) * Math.PI * 2) * 0.46]),
    [[0.34, 0.36], [0.35, 0.45]], [[0.65, 0.36], [0.66, 0.45]],
    Array.from({ length: 11 }, (_, i) => [0.27 + (i / 10) * 0.46, 0.6 + Math.sin((i / 10) * Math.PI) * 0.17]),
  ],
  // flower
  () => [Array.from({ length: 61 }, (_, i) => {
    const t = (i / 60) * Math.PI * 2;
    const r = 0.2 + 0.26 * Math.abs(Math.sin(t * 2.5));
    return [0.5 + Math.cos(t) * r, 0.5 + Math.sin(t) * r];
  })],
  // lightning zigzag
  () => [Array.from({ length: 9 }, (_, i) => [0.06 + (i / 8) * 0.88, i % 2 ? 0.74 : 0.26])],
  // wave
  () => [Array.from({ length: 33 }, (_, i) => [0.03 + (i / 32) * 0.94, 0.5 + Math.sin((i / 32) * Math.PI * 4) * 0.24])],
  // cloud
  () => [Array.from({ length: 49 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2;
    const r = 0.36 + 0.07 * Math.cos(t * 6);
    return [0.5 + Math.cos(t) * r * 1.25, 0.52 + Math.sin(t) * r * 0.72];
  })],
  // squiggly loops
  () => [Array.from({ length: 49 }, (_, i) => {
    const t = i / 48;
    return [0.1 + t * 0.8 + Math.cos(t * 8 * Math.PI) * 0.09, 0.5 + Math.sin(t * 8 * Math.PI) * 0.26];
  })],
];

function plan(view, seed) {
  const rand = seeded(seed);
  const order = view.glyphs.map((glyph, index) => ({ glyph, key: rand(), index })).sort((a, b) => a.key - b.key);
  const jobs = BOTS.map(() => []);
  let turn = Math.floor(rand() * BOTS.length);
  for (const { glyph } of order) {
    const brush = Math.max(9, glyph.size * 0.105);
    const bot = turn % BOTS.length;
    turn += 1;
    // Some tall letters are shared by two painters, top and bottom.
    if (glyph.h > glyph.size * 0.5 && rand() < 0.3) {
      const split = glyph.h * (0.42 + rand() * 0.16);
      const other = turn % BOTS.length;
      turn += 1;
      jobs[bot].push({ layer: 'fill', width: brush, color: BOTS[bot].inks[0], strokes: [scribble({ ...glyph, h: split }, brush, rand)] });
      jobs[other].push({ layer: 'fill', width: brush, color: BOTS[other].inks[1], strokes: [scribble({ ...glyph, y: glyph.y + split, h: glyph.h - split }, brush, rand)] });
    } else {
      const fillIn = FILLS[Math.floor(rand() * FILLS.length)];
      jobs[bot].push({ layer: 'fill', width: brush, color: BOTS[bot].inks[rand() < 0.62 ? 0 : 1], strokes: [fillIn(glyph, brush, rand)] });
    }
  }

  // Margin drawings wherever a line leaves room beside it.
  const spots = [];
  for (const row of view.rows) {
    const gap = view.width - (row.x + row.width);
    const box = Math.min(gap * 0.7, row.capHeight * 0.78);
    if (box >= 46) spots.push({ x: row.x + row.width + (gap - box) * 0.5, y: row.baseline - row.capHeight + (row.capHeight - box) * 0.5, box });
  }
  spots.forEach((spot, index) => {
    const bot = (turn + index) % BOTS.length;
    const strokes = DOODLES[Math.floor(rand() * DOODLES.length)]();
    jobs[bot].push({
      layer: 'top', width: Math.max(3.5, spot.box * 0.05), color: BOTS[bot].tag,
      strokes: strokes.map(stroke => stroke.map(([x, y]) => [spot.x + x * spot.box, spot.y + y * spot.box])),
    });
  });

  // Freestyle: every painter also draws whatever, wherever. Kept small and
  // thin so the headline underneath stays readable.
  BOTS.forEach((painter, bot) => {
    const count = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i += 1) {
      const box = view.mean * (0.2 + rand() * 0.2);
      const x = rand() * Math.max(1, view.width - box);
      const y = rand() * Math.max(1, view.height - box);
      const strokes = rand() < 0.3 ? wander(rand) : DOODLES[Math.floor(rand() * DOODLES.length)]();
      jobs[bot].push({
        layer: 'top', width: Math.max(3, box * 0.055), color: rand() < 0.5 ? painter.tag : painter.inks[0],
        strokes: strokes.map(stroke => stroke.map(([px, py]) => [x + px * box, y + py * box])),
      });
    }
  });

  // One hand-drawn double underline beneath the final line.
  const last = view.rows[view.rows.length - 1];
  const underY = last.baseline + last.size * 0.12;
  const wave = offset => Array.from({ length: 25 }, (_, i) => {
    const t = i / 24;
    return [last.x + last.width * (0.02 + t * 0.96), underY + offset + Math.sin(t * 9 + offset) * last.size * 0.012 - t * last.size * 0.03];
  });
  jobs[turn % BOTS.length].push({ layer: 'top', width: Math.max(4, last.size * 0.035), color: '#e7472d', strokes: [wave(0), wave(last.size * 0.055).reverse()] });

  // Flatten every painter's jobs into timed segments.
  return jobs.map((list, index) => {
    const segments = [];
    let at = [view.width * (0.15 + index * 0.23), -30];
    for (const job of list) {
      for (const stroke of job.strokes) {
        segments.push({ from: at, to: stroke[0], draw: false });
        for (let i = 1; i < stroke.length; i += 1) segments.push({ from: stroke[i - 1], to: stroke[i], draw: true, layer: job.layer, color: job.color, width: job.width });
        at = stroke[stroke.length - 1];
      }
    }
    // Step aside when finished so the name tags do not cover the poster.
    segments.push({ from: at, to: [view.width * (0.12 + index * 0.25), view.height - 8], draw: false });
    for (const segment of segments) {
      const length = Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]);
      segment.cost = Math.max(0.01, segment.draw ? length : length / TRAVEL_BOOST);
    }
    return { segments, index: 0, used: 0, at: segments[0].from };
  });
}

export default function JamPoster({ lines, preview = false }) {
  const frame = useRef(null);
  const fillCanvas = useRef(null);
  const topCanvas = useRef(null);
  const tags = useRef([]);
  const engine = useRef(null);
  const [paused, setPaused] = useState(false);
  const [joined, setJoined] = useState(false);
  const [ink, setInk] = useState(VISITOR_INKS[1].value);
  const [still, setStill] = useState(preview);
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const text = lines.join('\n');

  useEffect(() => {
    const host = frame.current;
    const fill = fillCanvas.current;
    const top = topCanvas.current;
    if (!host || !fill || !top) return undefined;
    const fillCtx = fill.getContext('2d');
    const topCtx = top.getContext('2d');
    if (!fillCtx || !topCtx) return undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const headlines = [text.split('\n'), ...MORE_HEADLINES];
    const state = { view: null, bots: [], seed: 7, elapsed: 0, doneAt: 0, visible: true, raf: 0, last: 0, strokes: [], disposed: false, fading: 0 };
    engine.current = state;
    const instant = () => preview || motion.matches;

    const stroke = (ctx, from, to, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
    };

    const paintBase = () => {
      const { view } = state;
      const scale = Math.min(2, window.devicePixelRatio || 1);
      for (const [canvas, ctx] of [[fill, fillCtx], [top, topCtx]]) {
        canvas.width = Math.round(view.width * scale);
        canvas.height = Math.round(view.height * scale);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
      // White letter interiors double as the mask: marker strokes use
      // source-atop, so color only ever lands inside the letters.
      fillCtx.globalCompositeOperation = 'source-over';
      fillCtx.fillStyle = '#fffdf6';
      topCtx.strokeStyle = INK;
      for (const row of view.rows) {
        fillCtx.font = topCtx.font = `400 ${row.size}px ${FONT}`;
        fillCtx.fillText(row.text, row.x, row.baseline);
        topCtx.lineWidth = Math.max(2.5, row.size * 0.028);
        topCtx.strokeText(row.text, row.x, row.baseline);
      }
      fillCtx.globalCompositeOperation = 'source-atop';
      for (const mark of state.strokes) {
        for (let i = 1; i < mark.points.length; i += 1) {
          stroke(topCtx, mark.points[i - 1].map(v => v * view.width), mark.points[i].map(v => v * view.width), mark.color, mark.width * view.width);
        }
      }
    };

    const advance = (budget) => {
      let busy = false;
      state.bots.forEach((bot, index) => {
        let left = budget;
        while (left > 0 && bot.index < bot.segments.length) {
          const segment = bot.segments[bot.index];
          const take = Math.min(left, segment.cost - bot.used);
          const t = (bot.used + take) / segment.cost;
          const next = [segment.from[0] + (segment.to[0] - segment.from[0]) * t, segment.from[1] + (segment.to[1] - segment.from[1]) * t];
          if (segment.draw) stroke(segment.layer === 'fill' ? fillCtx : topCtx, bot.at, next, segment.color, segment.width);
          bot.at = next;
          bot.used += take;
          left -= take;
          if (bot.used >= segment.cost - 1e-6) {
            bot.index += 1;
            bot.used = 0;
            if (bot.index < bot.segments.length) bot.at = bot.segments[bot.index].from;
          }
        }
        if (bot.index < bot.segments.length) busy = true;
        const tag = tags.current[index];
        if (tag) tag.style.transform = `translate(${bot.at[0].toFixed(1)}px, ${bot.at[1].toFixed(1)}px)`;
      });
      return busy;
    };

    const start = (fastForward = 0) => {
      const width = host.clientWidth;
      if (!width) return;
      // The page's own headline sets the poster's height; later lines are
      // fitted inside it so nothing below the poster ever jumps.
      const base = layout(topCtx, headlines[0], width);
      const rows = instant() ? headlines[0] : headlines[(state.seed - 7) % headlines.length];
      state.view = rows === headlines[0] ? base : layout(topCtx, rows, width);
      if (state.view.height > base.height) state.view = layout(topCtx, rows, width, base.height / state.view.height);
      state.view.height = base.height;
      host.style.height = base.height + 'px';
      paintBase();
      state.bots = plan(state.view, state.seed);
      state.doneAt = 0;
      if (instant()) { advance(Infinity); state.elapsed = 0; return; }
      if (fastForward > 0 && !advance(fastForward * state.view.mean * PACE)) state.doneAt = performance.now();
    };

    const tick = (now) => {
      state.raf = 0;
      if (state.disposed) return;
      const delta = Math.min(50, now - (state.last || now));
      state.last = now;
      if (state.view && state.visible && !document.hidden && !pausedRef.current && !instant()) {
        if (state.doneAt) {
          if (now - state.doneAt > HOLD_MS && !state.fading) {
            host.dataset.fading = 'true';
            state.fading = window.setTimeout(() => {
              state.fading = 0;
              state.seed += 1;
              state.elapsed = 0;
              start();
              delete host.dataset.fading;
            }, 520);
          }
        } else {
          state.elapsed += delta / 1000;
          if (!advance((delta / 1000) * state.view.mean * PACE)) state.doneAt = now;
        }
      }
      state.raf = window.requestAnimationFrame(tick);
    };

    const begin = () => {
      if (state.disposed) return;
      start(state.elapsed);
      setStill(instant());
      if (!state.raf && !instant()) state.raf = window.requestAnimationFrame(tick);
    };

    // Wait for the poster face so the first frame is not drawn in a fallback.
    const fonts = document.fonts?.load ? document.fonts.load(`400 100px Anton`).catch(() => {}) : Promise.resolve();
    Promise.race([fonts, new Promise(resolve => window.setTimeout(resolve, 1800))]).then(begin);

    let lastWidth = 0;
    const resize = new ResizeObserver(() => {
      const width = host.clientWidth;
      if (!state.view || Math.abs(width - lastWidth) < 1) { lastWidth = width; return; }
      lastWidth = width;
      start(state.doneAt ? Infinity : state.elapsed);
    });
    resize.observe(host);
    const watcher = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { state.visible = entry.isIntersecting; }) : null;
    watcher?.observe(host);
    const motionChanged = () => { state.elapsed = 0; begin(); };
    motion.addEventListener('change', motionChanged);

    // The visitor's own marker. Vertical swipes still scroll the page on touch.
    let mark = null;
    const point = event => {
      const box = top.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    const down = (event) => {
      if (preview || (event.pointerType === 'mouse' && event.button !== 0) || !state.view) return;
      const at = point(event);
      mark = { color: inkRef.current, width: Math.max(5, state.view.mean * 0.045) / state.view.width, points: [at.map(v => v / state.view.width)], at };
      state.strokes.push(mark);
      if (state.strokes.length > 400) state.strokes.shift();
      stroke(topCtx, at, [at[0] + 0.1, at[1]], mark.color, mark.width * state.view.width);
      try { top.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
      setJoined(true);
    };
    const move = (event) => {
      if (!mark || !state.view) return;
      const at = point(event);
      stroke(topCtx, mark.at, at, mark.color, mark.width * state.view.width);
      mark.at = at;
      if (mark.points.length < 600) mark.points.push(at.map(v => v / state.view.width));
    };
    const up = () => { mark = null; };
    top.addEventListener('pointerdown', down);
    top.addEventListener('pointermove', move);
    top.addEventListener('pointerup', up);
    top.addEventListener('pointercancel', up);

    return () => {
      state.disposed = true;
      window.cancelAnimationFrame(state.raf);
      window.clearTimeout(state.fading);
      resize.disconnect();
      watcher?.disconnect();
      motion.removeEventListener('change', motionChanged);
      top.removeEventListener('pointerdown', down);
      top.removeEventListener('pointermove', move);
      top.removeEventListener('pointerup', up);
      top.removeEventListener('pointercancel', up);
    };
  }, [text, preview]);

  return <figure className="jam-poster" data-no-ink="" data-still={still ? 'true' : undefined}>
    <div className="jam-poster-stage" ref={frame}>
      <canvas className="jam-poster-fill" ref={fillCanvas} aria-hidden="true" />
      <canvas className="jam-poster-top" ref={topCanvas} aria-hidden="true" />
      {!still && BOTS.map((bot, index) => <span className="jam-tag" key={bot.name} aria-hidden="true"
        ref={node => { tags.current[index] = node; }} style={{ '--tag': bot.tag }}>
        <svg width="18" height="20" viewBox="0 0 18 20"><path d="M2 1.5 16 10l-6.6 1.4L6 18Z" fill="var(--tag)" stroke="#181916" strokeWidth="1.6" strokeLinejoin="round" /></svg>
        <b>{bot.name}</b>
      </span>)}
    </div>
    <figcaption className="jam-poster-caption">
      <p>
        {joined
          ? <><strong>You’re in.</strong> A real room works just like this, with your friends holding the other markers.</>
          : <><strong>{BOTS.map(bot => bot.name).join(', ').replace(/, ([^,]*)$/, ' & $1')}</strong> are demo bots painting this poster. Grab a marker and draw on it.</>}
      </p>
      {!preview && <div className="jam-poster-tools">
        <div className="jam-inks" role="group" aria-label="Your marker color">
          {VISITOR_INKS.map(option => <button type="button" key={option.value} className="jam-ink" style={{ '--chip': option.value }}
            aria-label={option.name + ' marker'} aria-pressed={ink === option.value} title={option.name + ' marker'} onClick={() => setInk(option.value)} />)}
        </div>
        {!still && <button type="button" className="jam-pause" onClick={() => setPaused(value => !value)}
          aria-label={paused ? 'Resume the coloring demo' : 'Pause the coloring demo'} title={paused ? 'Resume' : 'Pause'}>
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor">
            {paused ? <path d="m5 2.6 10 6.4-10 6.4z" /> : <path d="M4 3h3.5v12H4zm6.5 0H14v12h-3.5z" />}
          </svg>
        </button>}
      </div>}
    </figcaption>
  </figure>;
}
