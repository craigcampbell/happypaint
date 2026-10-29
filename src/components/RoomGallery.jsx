import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import "./room-gallery.css";

const LiveRoomCanvas = lazy(() => import("./LiveRoomCanvas"));

function publicDrawnRooms(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((room) => {
    if (!room || !/^[A-Z0-9]{1,8}$/.test(room.code) || seen.has(room.code) || !(room.ops > 0) || room.listed === false || (room.audience && room.audience !== "kid_safe")) return false;
    seen.add(room.code); return true;
  });
}

function GifPreview({ code, visible, onDenied }) {
  const [gif, setGif] = useState("");
  const [poster, setPoster] = useState("");
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const workerRef = useRef(null);
  const urlRef = useRef("");
  const clear = useCallback(() => {
    workerRef.current?.terminate(); workerRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setPlaying(!media.matches);
    media.addEventListener("change", change);
    return () => { media.removeEventListener("change", change); clear(); };
  }, [clear]);
  useEffect(() => { if (!visible) { clear(); setGif(""); setPoster(""); } }, [visible, clear]);
  const onFrames = useCallback((data) => {
    clear(); setGif(""); setError(false);
    if (!data) { setPoster(""); return; }
    setPoster(data.poster);
    try {
      const worker = new Worker(new URL("../utils/gif.worker.js", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.onmessage = (event) => {
        if (workerRef.current !== worker) return;
        if (!event.data?.ok) { setError(true); worker.terminate(); return; }
        const url = URL.createObjectURL(new Blob([event.data.bytes], { type: "image/gif" }));
        urlRef.current = url; setGif(url); worker.terminate(); workerRef.current = null;
      };
      worker.onerror = () => { if (workerRef.current === worker) setError(true); worker.terminate(); };
      const frames = data.frames.map(({ source, delayMs }) => ({ buffer: source.data.buffer, width: source.width, height: source.height, delayMs }));
      // The completed artwork is used twice (first and last); clone its buffers
      // so each transferable appears once without detaching the shared sample.
      const uniqueFrames = frames.map((frame) => ({ ...frame, buffer: frame.buffer.slice(0) }));
      worker.postMessage({ id: 1, width: 320, height: 200, frames: uniqueFrames }, uniqueFrames.map((frame) => frame.buffer));
    } catch { setError(true); }
  }, [clear]);
  const deny = useCallback(() => { clear(); setGif(""); setPoster(""); onDenied(); }, [clear, onDenied]);
  return <>
    <div className="room-remix-preview">
      {visible ? <div className="room-remix-source" aria-hidden="true"><Suspense fallback={null}><LiveRoomCanvas roomCode={code} onReplayFrames={onFrames} onDenied={deny} /></Suspense></div> : null}
      {poster ? <img src={playing && gif ? gif : poster} alt={playing && gif ? `Room replay GIF: ${code}` : `Room preview: ${code}`} /> : <p className="room-remix-status" role="status">{visible ? "Replaying the room’s drawing…" : "Preview paused while this tab is hidden."}</p>}
    </div>
    <div className="room-remix-controls"><button type="button" onClick={() => setPlaying((value) => !value)} disabled={!gif}>{playing ? "Pause GIF" : "Play GIF"}</button><span className="discovery-note">{error ? "GIF preview is unavailable; showing the room artwork." : "A short replay of this public canvas. Not a video stream."}</span></div>
  </>;
}

export default function RoomGallery({ onNavigate }) {
  const [room, setRoom] = useState(null);
  const [status, setStatus] = useState("loading");
  const [visible, setVisible] = useState(() => !document.hidden);
  const currentRef = useRef(null);
  const fetchRef = useRef(null);
  const mountedRef = useRef(true);
  const load = useCallback(async (shuffle = false) => {
    fetchRef.current?.abort();
    const controller = new AbortController(); fetchRef.current = controller;
    if (shuffle) setStatus("loading");
    try {
      const response = await fetch("/api/rooms/public", { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("public_lobby_unavailable");
      const data = await response.json();
      if (!mountedRef.current || controller.signal.aborted) return;
      const rooms = publicDrawnRooms(data.rooms);
      const existing = rooms.find((item) => item.code === currentRef.current?.code);
      if (!shuffle && existing) { setRoom(existing); currentRef.current = existing; setStatus("ready"); return; }
      const others = rooms.filter((item) => item.code !== currentRef.current?.code);
      const pool = others.length ? others : rooms;
      const next = pool[Math.floor(Math.random() * pool.length)] || null;
      currentRef.current = next; setRoom(next); setStatus(next ? "ready" : "empty");
    } catch (error) {
      if (error.name !== "AbortError" && mountedRef.current) { setRoom(null); setStatus("error"); }
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    if (!document.hidden) load();
    const visibility = () => {
      setVisible(!document.hidden);
      // Revalidate discovery permission before showing a room again.
      if (!document.hidden) { setRoom(null); load(); }
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => { mountedRef.current = false; fetchRef.current?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [load]);
  const denied = useCallback(() => { setRoom(null); setStatus("denied"); }, []);
  const follow = (event, href) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate(href);
  };
  return <section className="room-remix-gallery" data-room-code={room?.code || ""} aria-labelledby="room-gallery-title">
    <div className="discovery-section-heading"><div><h2 id="room-gallery-title">Room shuffle</h2><p className="discovery-note">A random public drawing. Your next idea starts here.</p></div><div className="room-remix-controls"><a className="primary-action" href="/draw" onClick={(event) => follow(event, "/draw")}>Make your own</a><button type="button" onClick={() => load(true)}>Shuffle room</button></div></div>
    {room ? <><h3>{room.title || `Room ${room.code}`}</h3><GifPreview key={room.code} code={room.code} visible={visible} onDenied={denied} /></> : <p className="room-remix-status" role="status">{status === "empty" ? "No public rooms with drawings are available yet. Make the first mark on your own canvas." : status === "error" ? "Couldn’t load public rooms. Try shuffling again." : status === "denied" ? "That room is no longer available to watch. Shuffle to another public drawing." : "Finding a public drawing…"}</p>}
    <div className="room-remix-controls">{room ? <a href={`/live/${room.code}`} onClick={(event) => follow(event, `/live/${room.code}`)}>Watch this room →</a> : null}</div>
    <p className="discovery-note">Make your own opens a separate blank canvas. It does not copy or edit anyone else’s artwork. Only listed public rooms are shown.</p>
  </section>;
}
