// Join curtain — the paint-stroke loading modal that covers the canvas area
// while a room hooks up, so nobody sits in front of a blank white rectangle
// wondering whether Drawesome is broken.
//
// The bar is not a fake timer. Each join milestone the studio reports (socket
// opening → socket open → handshake in → shared history painted) sets a target
// and the stroke eases toward it, so a slow room visibly creeps instead of
// freezing on a lie. Progress is written straight to a CSS custom property from
// one rAF loop — no React render per frame, no layout — and both the loop and
// its keepalive die with the curtain, so nothing here can cost a drawing frame.
//
// The curtain closes itself on a quick join. Past SLOW_JOIN_MS the painter has
// been staring long enough to have looked away, so it waits for an explicit OK
// rather than yanking the modal out from under them. A join that never lands
// gets that OK too (STUCK_MS) — the curtain must never trap anyone.

import { useEffect, useRef, useState } from "react";

// Milestones, in the order the studio reports them. Each one sweeps quickly to
// `arrive` — that jump is what makes a milestone feel like progress — and then
// crawls toward `ceiling` for as long as the step takes. The crawl is the whole
// trick: a bar parked on an exact number reads as broken, and a bar that runs
// ahead of the truth is a lie. `ceiling` always stops short of the next step's
// arrival, so no step can ever claim the next one's ground.
const STEPS = [
  { arrive: 18, ceiling: 44, label: "Squeezing out the paints…" },
  { arrive: 52, ceiling: 72, label: "Knocking on the room door…" },
  { arrive: 80, ceiling: 94, label: "Rolling out a fresh canvas…" },
  { arrive: 100, ceiling: 100, label: "Hanging up everyone's art…" },
];

const SWEEP_RATE = 7; // per second, easing onto a milestone
const FINISH_RATE = 10.5; // per second, the last run home
const CRAWL_RATE = 0.2; // per second, the "still working" drift

const SLOW_JOIN_MS = 5000; // past this, the painter taps OK instead of a snap-away
const STUCK_MS = 15000; // a join that never finishes still gets a way in
const CLOSE_BEAT_MS = 520; // let the last brush stroke land before closing

// The paint the stroke lays down, left to right. The % readout, the wet leading
// edge and the brush bristles are tinted from this same ramp, so the number
// always wears the colour the brush is holding.
const PAINT = ["#ff4d8d", "#ff8f1f", "#ffc21f", "#38d996", "#0878d1", "#8b5cf6"];

// Brightest a colour may be before the % readout wears it. Paint that looks
// great on the stroke (the ambers especially) is unreadable as text on white,
// so the readout gets the same hue taken down until it is. Tuned so the whole
// ramp clears 4.5:1 on the card.
const INK_MAX_LUMA = 0.16;

// One wobbly brush stroke, drawn once and shared by the paint layer and the
// dashed pencil guide underneath it (so you can see where the paint is headed).
// The viewBox is 1200x120 stretched with preserveAspectRatio="none": the band
// lives in y 16-90 and the drips hang below it.
const STROKE_PATH =
  "M5 52C5 34 46 16 130 18C232 21 338 13 442 20C546 27 636 12 742 19C848 26 942 15 1042 21" +
  "C1112 25 1162 31 1195 39L1195 67C1162 76 1112 82 1042 86C942 92 848 81 742 88" +
  "C636 95 546 80 442 87C338 94 232 86 130 89C46 91 5 70 5 52Z";

// Paint that ran. They are revealed by the same clip as the stroke, so each one
// looks like it starts running the moment the brush lays that patch down.
const DRIPS = [
  "M286 80C281 93 284 102 295 109C306 102 309 93 304 80Z",
  "M676 84C672 94 674 101 683 106C692 101 694 94 690 84Z",
  "M988 78C984 88 986 95 994 100C1002 95 1004 88 1000 78Z",
];

function mixHex(from, to, t) {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const channel = (shift) => {
    const start = (a >> shift) & 255;
    const end = (b >> shift) & 255;
    return Math.round(start + (end - start) * t);
  };
  return [channel(16), channel(8), channel(0)];
}

// The colour the brush is holding at `percent` — the same ramp the SVG gradient
// paints, sampled in JS so the bristles and the readout match the wet stroke.
function paintAt(percent) {
  const spot = (Math.max(0, Math.min(100, percent)) / 100) * (PAINT.length - 1);
  const index = Math.min(PAINT.length - 2, Math.floor(spot));
  return mixHex(PAINT[index], PAINT[index + 1], spot - index);
}

const css = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

function relativeLuma(rgb) {
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

// Same hue, dimmed until it can be read on the card. Scaling all three channels
// keeps the paint recognisable — the amber stretch reads as dark gold rather
// than washing out to grey. Luminance goes roughly as the 2.4th power of the
// channels, so that is the exponent the scale has to undo.
function readable(rgb) {
  const luma = relativeLuma(rgb);
  if (luma <= INK_MAX_LUMA) return css(rgb);
  const scale = Math.pow(INK_MAX_LUMA / luma, 1 / 2.4);
  return css(rgb.map((channel) => Math.round(channel * scale)));
}

export default function RoomLoadingCurtain({ step = 0, roomLabel = "", onClose }) {
  const cardRef = useRef(null);
  const numberRef = useRef(null);
  const barRef = useRef(null);
  const okRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The rAF loop reads the live step through a ref, so a milestone landing never
  // restarts the animation (a restart would visibly jolt the stroke).
  const stage = Math.max(0, Math.min(STEPS.length - 1, step));
  const stepRef = useRef(0);
  stepRef.current = stage;

  const [needsOk, setNeedsOk] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const startedAt = performance.now();
    let raf = 0;
    let closeTimer = 0;
    let keepalive = 0;
    let progress = 0;
    let shown = -1;
    let last = startedAt;
    let lastFrameAt = startedAt;
    let okArmed = false;
    let settled = false;

    const write = () => {
      const card = cardRef.current;
      if (!card) return;
      const wet = paintAt(progress);
      card.style.setProperty("--p", progress.toFixed(2));
      card.style.setProperty("--ink", css(wet));
      card.style.setProperty("--ink-text", readable(wet));
      const rounded = Math.round(progress);
      if (rounded === shown) return;
      shown = rounded;
      if (numberRef.current) numberRef.current.textContent = String(rounded);
      barRef.current?.setAttribute("aria-valuenow", String(rounded));
    };

    // Elapsed-time easing rather than per-frame, so the stroke moves at the same
    // rate on a 120Hz iPad and on a browser that has throttled us to 4fps.
    const advance = (now) => {
      if (settled) return;
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      const atEnd = stepRef.current >= STEPS.length - 1;
      const milestone = STEPS[stepRef.current];
      const rate = progress < milestone.arrive ? (atEnd ? FINISH_RATE : SWEEP_RATE) : CRAWL_RATE;
      const gap = milestone.ceiling - progress;
      progress = Math.min(milestone.ceiling, progress + gap * (1 - Math.exp(-rate * dt)));
      write();

      const elapsed = now - startedAt;
      if (atEnd && progress > 99.5) {
        settled = true;
        progress = 100;
        write();
        setDone(true);
        if (okArmed || elapsed >= SLOW_JOIN_MS) {
          setNeedsOk(true);
          setStalled(false);
        } else {
          closeTimer = window.setTimeout(() => onCloseRef.current?.(), CLOSE_BEAT_MS);
        }
        return; // the stroke is laid down
      }
      if (!okArmed && elapsed >= STUCK_MS) {
        // Still hooking up. Keep painting, but offer a way in rather than
        // holding someone hostage in front of their own canvas.
        okArmed = true;
        setNeedsOk(true);
        setStalled(true);
      }
    };

    const tick = (now) => {
      lastFrameAt = now;
      advance(now);
      if (!settled) raf = window.requestAnimationFrame(tick);
    };

    // rAF paints it smoothly; this drives it when the browser stops handing out
    // frames at all (backgrounded tab, occluded window). Without it, tabbing
    // away mid-join means coming back to a curtain that never finishes.
    keepalive = window.setInterval(() => {
      const now = performance.now();
      if (settled || now - lastFrameAt < 600) return;
      advance(now);
    }, 250);

    write();
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      if (closeTimer) window.clearTimeout(closeTimer);
      window.clearInterval(keepalive);
    };
  }, []);

  // Once the OK button exists it is the only thing left to do — put the keyboard on it.
  useEffect(() => {
    if (needsOk) okRef.current?.focus();
  }, [needsOk]);

  const label = done ? "All set — happy painting!" : STEPS[stage].label;

  return (
    <div className="load-curtain" role="dialog" aria-modal="true" aria-labelledby="load-curtain-title">
      <section className="load-card" ref={cardRef}>
        <div className="load-dots" aria-hidden="true">
          {PAINT.map((color, index) => (
            <i key={color} style={{ "--c": color, "--i": index }} />
          ))}
        </div>

        <h2 id="load-curtain-title">{done ? "Your canvas is ready!" : "Painting your canvas…"}</h2>

        <div
          className="load-track"
          ref={barRef}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          aria-label="Loading the room"
        >
          {/* Pencil rough of the whole stroke, so you can see where the paint is going. */}
          <svg className="load-guide" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
            <path d={STROKE_PATH} fill="none" stroke="#d6dee6" strokeWidth="3" strokeDasharray="9 11" />
          </svg>

          {/* The paint itself: laid down full width, then revealed left to right
              by a clip-path driven from --p. Because the gradient is painted
              across the WHOLE stroke, the colour genuinely changes as the brush
              uncovers it rather than the bar being recoloured wholesale. */}
          <div className="load-paint">
            <svg viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="load-paint-ramp" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1200" y2="0">
                  {PAINT.map((color, index) => (
                    <stop key={color} offset={index / (PAINT.length - 1)} stopColor={color} />
                  ))}
                </linearGradient>
              </defs>
              {DRIPS.map((drip) => (
                <path key={drip} d={drip} fill="url(#load-paint-ramp)" opacity="0.9" />
              ))}
              <path d={STROKE_PATH} fill="url(#load-paint-ramp)" />
              {/* Bristle drag: light streaks where the brush spread thin, a dark
                  one where the paint pooled behind it. */}
              <g fill="none" strokeLinecap="round">
                <path
                  d="M46 38C210 30 430 44 650 35C870 26 1050 40 1186 47"
                  stroke="#ffffff"
                  strokeOpacity="0.38"
                  strokeWidth="4"
                />
                <path
                  d="M52 60C224 69 436 55 668 64C888 73 1058 59 1188 57"
                  stroke="#ffffff"
                  strokeOpacity="0.22"
                  strokeWidth="3"
                />
                <path
                  d="M70 76C266 83 476 71 706 79C892 86 1040 74 1180 66"
                  stroke="#000000"
                  strokeOpacity="0.10"
                  strokeWidth="3"
                />
              </g>
            </svg>
          </div>

          {/* Wet paint pooled at the tip — it also hides the clip's hard edge. */}
          <span className="load-wet" aria-hidden="true" />

          {/* The brush doing the work, riding the leading edge with its bristles
              dipped in whatever colour the stroke is laying down right now. */}
          <span className="load-brush" aria-hidden="true">
            <svg viewBox="0 0 34 62" aria-hidden="true">
              <rect x="12" y="0" width="10" height="30" rx="5" fill="#e0a860" />
              <rect x="14" y="2" width="3" height="26" rx="1.5" fill="#f2c88c" />
              <rect x="10" y="27" width="14" height="10" rx="3" fill="#c8d2dc" />
              <rect x="11" y="29" width="12" height="2.5" rx="1.2" fill="#eef3f8" />
              <path
                d="M11 36h12l-2.5 16c-.6 4-2 7-3.5 9-1.5-2-2.9-5-3.5-9L11 36Z"
                fill="var(--ink, #ff4d8d)"
              />
              <path
                d="M14.5 37.5 15 55M19.5 37.5 19 55"
                stroke="#000000"
                strokeOpacity="0.14"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </div>

        <div className="load-meta">
          <span className="load-pct">
            <b ref={numberRef}>0</b>%
          </span>
          <span className="load-stage" aria-live="polite">
            {label}
          </span>
          {roomLabel ? <span className="load-room">{roomLabel}</span> : null}
        </div>

        {needsOk ? (
          <>
            {stalled ? (
              <p className="load-hint">This room is taking its time. Head on in — the art pops up as it arrives.</p>
            ) : null}
            <button type="button" className="primary-action load-ok" ref={okRef} onClick={onClose}>
              {stalled ? "Go in anyway" : "OK — let's paint! 🎨"}
            </button>
          </>
        ) : null}
      </section>
    </div>
  );
}
