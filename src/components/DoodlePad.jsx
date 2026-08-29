import { useEffect, useRef, useState } from "react";

// DoodlePad — the 10-second meme machine. A tiny canvas that opens from the
// chat composer; the sketch sends as a chat bubble (a "doodle reply"). Kept
// deliberately simple: a few fat pens, an eraser, clear, send. Pointer events
// only (mouse/touch/pen all work), drawn at 2x for crisp bubbles.
const PAD_W = 260;
const PAD_H = 180;
const SCALE = 2; // backing-store scale → crisp on retina, still a tiny PNG
const PENS = ["#111827", "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"];

export default function DoodlePad({ onSend, onClose }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const dirtyRef = useRef(false);
  const [pen, setPen] = useState(PENS[0]);
  const [erasing, setErasing] = useState(false);

  // White ground: the PNG must read as a bubble on any theme, and a
  // transparent doodle over a dark panel would vanish.
  useEffect(() => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PAD_W * SCALE, PAD_H * SCALE);
  }, []);

  const point = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * PAD_W * SCALE,
      y: ((e.clientY - rect.top) / rect.height) * PAD_H * SCALE,
    };
  };

  const start = (e) => {
    e.preventDefault();
    canvasRef.current.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    lastRef.current = point(e);
    move(e); // dot on tap
  };
  const move = (e) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const p = point(e);
    const from = lastRef.current || p;
    ctx.strokeStyle = erasing ? "#ffffff" : pen;
    ctx.lineWidth = (erasing ? 22 : 7) * SCALE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    // Erasing paints white-on-white — it can never make a blank canvas
    // sendable, so only real pen strokes flip the dirty flag.
    if (!erasing) dirtyRef.current = true;
  };
  const end = () => {
    drawingRef.current = false;
    lastRef.current = null;
  };

  const clear = () => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PAD_W * SCALE, PAD_H * SCALE);
    dirtyRef.current = false;
  };

  const send = () => {
    if (!dirtyRef.current) return; // a blank white rectangle is not a meme
    // JPEG keeps a fat-pen sketch small (well under the server's byte cap).
    onSend?.(canvasRef.current.toDataURL("image/jpeg", 0.8));
  };

  return (
    <div className="doodle-pad">
      <div className="doodle-pad-head">
        <span>✏️ Doodle reply</span>
        <button type="button" onClick={onClose} aria-label="Close doodle pad">✕</button>
      </div>
      <canvas
        ref={canvasRef}
        width={PAD_W * SCALE}
        height={PAD_H * SCALE}
        /* Sized by CSS (width:100% + aspect-ratio) so the pad SHRINKS to fit
           the mobile bottom sheet — a fixed pixel height clipped the Send
           button off-screen on phones. point() normalizes by the rendered
           rect, so drawing coordinates stay correct at any size. */
        style={{ touchAction: "none" }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="doodle-pad-tools">
        {PENS.map((c) => (
          <button
            key={c}
            type="button"
            className={`doodle-pen${!erasing && pen === c ? " is-active" : ""}`}
            style={{ background: c }}
            onClick={() => { setPen(c); setErasing(false); }}
            aria-label={`Pen ${c}`}
          />
        ))}
        <button
          type="button"
          className={`doodle-tool${erasing ? " is-active" : ""}`}
          onClick={() => setErasing((v) => !v)}
          title="Eraser"
        >
          🧽
        </button>
        <button type="button" className="doodle-tool" onClick={clear} title="Start over">🗑️</button>
        <button type="button" className="doodle-send" onClick={send}>Send ↑</button>
      </div>
    </div>
  );
}
