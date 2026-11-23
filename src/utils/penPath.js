// Pen path tool: an Illustrator-style Bezier path for mouse and keyboard
// painters. The path is only a guide: when it is finished it is sampled into
// ordinary brush points and replayed through the normal stroke pipeline, so
// what lands on the canvas (and on the wire) is a plain brush stroke.
//
// A node is { x, y, ox, oy } in document space. (ox, oy) is the outgoing
// handle offset; the incoming handle mirrors it. A corner node has ox = oy = 0.

export const PEN_SAMPLE_SPACING = 3; // doc px between replayed brush points
const PEN_PRESSURE = 0.7; // steady hand: a little heavier than a quick mouse flick
const PEN_TAPER_MIN = 0.12;
const PEN_TAPER_PEAK = 0.85;

function cubicAt(a, b, t) {
  const p1x = a.x + a.ox;
  const p1y = a.y + a.oy;
  const p2x = b.x - b.ox;
  const p2y = b.y - b.oy;
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * p1x + w2 * p2x + w3 * b.x,
    y: w0 * a.y + w1 * p1y + w2 * p2y + w3 * b.y,
  };
}

function segmentPairs(nodes, closed) {
  const pairs = [];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    pairs.push([nodes[i], nodes[i + 1]]);
  }
  if (closed && nodes.length > 2) {
    pairs.push([nodes[nodes.length - 1], nodes[0]]);
  }
  return pairs;
}

// Flatten one segment finely enough that the polyline is the curve.
function flatten(a, b) {
  const rough =
    Math.hypot(a.ox, a.oy) + Math.hypot(b.ox, b.oy) + Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.min(1500, Math.ceil(rough)));
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    out.push(cubicAt(a, b, i / steps));
  }
  return out;
}

function smoothstep(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

// Simulated pen pressure along the path. With taper the line swells in and
// thins out like a brush pen; a closed outline keeps one even weight.
export function penPressureAt(distance, total, { taper = true, closed = false } = {}) {
  if (!taper || closed || total <= 0) {
    return PEN_PRESSURE;
  }
  const ramp = Math.max(1, Math.min(total * 0.3, 110));
  const edge = Math.min(distance, total - distance);
  return PEN_TAPER_MIN + (PEN_TAPER_PEAK - PEN_TAPER_MIN) * smoothstep(edge / ramp);
}

// Sample the path into brush points: evenly spaced along each segment, with
// every node kept exactly so corners stay sharp.
export function samplePenPath(nodes, { closed = false, taper = true, spacing = PEN_SAMPLE_SPACING } = {}) {
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return [];
  }
  const placed = [{ x: nodes[0].x, y: nodes[0].y, d: 0 }];
  let total = 0;
  for (const [a, b] of segmentPairs(nodes, closed)) {
    let prev = a;
    let carry = 0;
    const flat = flatten(a, b);
    flat.forEach((point, index) => {
      const step = Math.hypot(point.x - prev.x, point.y - prev.y);
      total += step;
      carry += step;
      const isNode = index === flat.length - 1;
      if (carry >= spacing || isNode) {
        placed.push({ x: point.x, y: point.y, d: total });
        carry = 0;
      }
      prev = point;
    });
  }
  return placed.map((point) => ({
    x: Math.round(point.x * 4) / 4,
    y: Math.round(point.y * 4) / 4,
    pressure: Math.round(penPressureAt(point.d, total, { taper, closed }) * 100) / 100,
  }));
}

// Hold Shift: snap the direction from `origin` to the nearest 45 degrees.
export function constrainAngle(origin, point) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return { x: point.x, y: point.y };
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

// Draw the guide (curve, rubber band, handles, anchors) in SCREEN space.
// `toScreen` maps a document point to canvas CSS pixels.
export function drawPenGuide(ctx, pen, toScreen) {
  const { nodes, hover, closed } = pen;
  if (!nodes.length) {
    return;
  }
  const trace = () => {
    const start = toScreen(nodes[0].x, nodes[0].y);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    for (const [a, b] of segmentPairs(nodes, closed)) {
      const c1 = toScreen(a.x + a.ox, a.y + a.oy);
      const c2 = toScreen(b.x - b.ox, b.y - b.oy);
      const end = toScreen(b.x, b.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    }
  };
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // White under blue reads on any paint color.
  trace();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3.5;
  ctx.stroke();
  trace();
  ctx.strokeStyle = "#1d6bf3";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const last = nodes[nodes.length - 1];
  if (hover && !pen.drag && !closed) {
    const from = toScreen(last.x, last.y);
    const c1 = toScreen(last.x + last.ox, last.y + last.oy);
    const to = toScreen(hover.x, hover.y);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(c1.x, c1.y, to.x, to.y, to.x, to.y);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#1d6bf3";
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Handles of the newest smooth node, so the bend being pulled is visible.
  if (last.ox || last.oy) {
    const anchor = toScreen(last.x, last.y);
    const out = toScreen(last.x + last.ox, last.y + last.oy);
    const inn = toScreen(last.x - last.ox, last.y - last.oy);
    ctx.beginPath();
    ctx.moveTo(inn.x, inn.y);
    ctx.lineTo(anchor.x, anchor.y);
    ctx.lineTo(out.x, out.y);
    ctx.strokeStyle = "#1d6bf3";
    ctx.lineWidth = 1;
    ctx.stroke();
    for (const knob of [inn, out]) {
      ctx.beginPath();
      ctx.arc(knob.x, knob.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#1d6bf3";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }

  nodes.forEach((node, index) => {
    const at = toScreen(node.x, node.y);
    const isEnd = index === nodes.length - 1;
    const isStart = index === 0;
    const half = isStart || isEnd ? 4.5 : 3.5;
    ctx.beginPath();
    ctx.rect(at.x - half, at.y - half, half * 2, half * 2);
    ctx.fillStyle = isEnd ? "#1d6bf3" : "#fff";
    ctx.fill();
    ctx.strokeStyle = isEnd ? "#fff" : "#1d6bf3";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // The start point grows a ring once the path can be closed onto it.
    if (isStart && nodes.length > 2 && !closed) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(29,107,243,0.55)";
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  });
}
