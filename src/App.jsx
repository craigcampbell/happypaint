import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import './App.css';
import { usePaintEngine } from './hooks/usePaintEngine';
import { useDrawing } from './hooks/useDrawing';
import { useWebSocket } from './hooks/useWebSocket';

import ColorSelector from './components/ColorSelector';
import BrushSelector from './components/BrushSelector';
import PaintTypeSelector from './components/PaintTypeSelector';
import UserList from './components/UserList';
import { BRUSH_TYPES, DEFAULT_PAINT_TYPE, VIRTUAL_CANVAS_WIDTH, VIRTUAL_CANVAS_HEIGHT, MIN_ZOOM, MAX_ZOOM, ZOOM_PER_SCROLL, PAINT_MIN_ZOOM, MURAL_BACKGROUND_COLOR } from './utils/constants';
import { PAINT_TYPES, PAINT_PROPERTIES } from './utils/paintTypes';

const BRUSH_OPTIONS = [
  { value: BRUSH_TYPES.ROUND, label: '🖌️ Brush' },
  { value: BRUSH_TYPES.SQUARE, label: '⬜ Square' },
  { value: BRUSH_TYPES.WET_BRUSH, label: '💧 Wet Brush' },
  { value: BRUSH_TYPES.SPRAY, label: '💨 Spray' },
  { value: BRUSH_TYPES.AIRBRUSH, label: '☁️ Airbrush' },
  { value: BRUSH_TYPES.PENCIL, label: '✏️ Pencil' },
  { value: BRUSH_TYPES.PEN, label: '🖊️ Pen' },
  { value: BRUSH_TYPES.LINE, label: '📏 Line' },
  { value: BRUSH_TYPES.SPONGE, label: '🧽 Sponge' },
  { value: BRUSH_TYPES.PALETTE_KNIFE, label: '🔪 Palette Knife' },
  { value: BRUSH_TYPES.BLUR, label: '🌫️ Blur' },
  { value: BRUSH_TYPES.SMUDGE, label: '👆 Smudge' },
  { value: BRUSH_TYPES.ERASER, label: '🧹 Eraser' },
  { value: BRUSH_TYPES.CHAT, label: '💬 Chat' },
  { value: BRUSH_TYPES.MEME, label: '🖼️ Meme' },
];

const MURAL_PROMPTS = [
  'Add a tiny doorway to somewhere impossible',
  'Paint a weather mood',
  'Hide a creature made of only three shapes',
  'Draw the sound of your favorite song',
  'Turn someone else\'s line into a landmark',
  'Add a pattern that repeats across the wall',
];

const MAX_MURAL_ARTISTS = 24;
const MIN_MEME_STAMP_SIZE = 64;

function normalizeMuralId(value) {
  return (value || 'main')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'main';
}

function getInitialMuralId() {
  if (typeof window === 'undefined') return 'main';
  const params = new URLSearchParams(window.location.search);
  return normalizeMuralId(params.get('mural') || window.location.hash.replace('#', '') || 'main');
}

function formatSavedAt(timestamp) {
  if (!timestamp) return 'Waiting for the first mark';
  return `Saved ${new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function getMemeCenter(meme) {
  return {
    x: meme.centerX ?? meme.x + meme.width / 2,
    y: meme.centerY ?? meme.y + meme.height / 2,
  };
}

function App() {
  const [currentBrush, setCurrentBrush] = useState(BRUSH_TYPES.ROUND);
  const [brushSize, setBrushSize] = useState(8);
  const [brushOpacity, setBrushOpacity] = useState(1);
  const [selectedColor, setSelectedColor] = useState('#1a1a2e');
  const [paintType, setPaintType] = useState(DEFAULT_PAINT_TYPE);
  const [showToolbar, setShowToolbar] = useState(true);
  const [showUserList, setShowUserList] = useState(true);
  const [users, setUsers] = useState([]);
  const [roomId, setRoomId] = useState(getInitialMuralId);
  const [roomDraft, setRoomDraft] = useState(roomId);
  const [userName, setUserName] = useState('');
  const [userColor, setUserColor] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushVariation, setBrushVariation] = useState(0.2);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [muralSavedAt, setMuralSavedAt] = useState(null);
  const [muralStatus, setMuralStatus] = useState('Mural history loads when artists join.');
  const [muralError, setMuralError] = useState('');
  const [inviteCopied, setInviteCopied] = useState(false);
  const [featuredMurals, setFeaturedMurals] = useState([]);
  const [activePromptIndex, setActivePromptIndex] = useState(0);

  // Chat brush threads: {id, x, y, messages: [{id, user, color, text, timestamp}]}
  const [chatThreads, setChatThreads] = useState([]);
  const [activeReplyId, setActiveReplyId] = useState(null); // thread id being replied to
  const [chatBrushInput, setChatBrushInput] = useState('');
  const chatBrushInputRef = useRef(null);

  // Meme brush: animated references are overlays, while every chosen image is stamped into the mural canvas.
  const [memes, setMemes] = useState([]);
  const [memeStampSource, setMemeStampSource] = useState(null);
  const [memePreview, setMemePreview] = useState(null);
  const [showMemes, setShowMemes] = useState(true);
  const [showChatThreads, setShowChatThreads] = useState(true);
  const memeFileRef = useRef(null);
  const memePendingPos = useRef(null);
  const memeDragStart = useRef(null);

  const canvasContainerRef = useRef(null);
  const paintCanvasRef = useRef(null);
  const minimapCanvasRef = useRef(null);
  const [containerSize, setContainerSize] = useState({
    width: Math.max(400, window.innerWidth),
    height: Math.max(300, window.innerHeight),
  });

  // Viewport state (what portion of the virtual canvas is visible)
  const [viewport, setViewport] = useState({
    x: VIRTUAL_CANVAS_WIDTH / 2,
    y: VIRTUAL_CANVAS_HEIGHT / 2,
    zoom: 0.5,
  });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const pendingImpasto = useRef([]);
  const pendingSmear = useRef([]);

  // Track in-progress remote live strokes (strokeId -> accumulated stroke data)
  const remoteLiveStrokes = useRef(new Map());

  // Track container size for viewport calculations
  useEffect(() => {
    const updateSize = () => {
      if (canvasContainerRef.current) {
        const rect = canvasContainerRef.current.getBoundingClientRect();
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);
        if (w > 0 && h > 0) {
          setContainerSize({ width: w, height: h });
        }
      }
    };

    const timer = setTimeout(updateSize, 50);
    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    if (canvasContainerRef.current) {
      resizeObserver.observe(canvasContainerRef.current);
    }
    return () => {
      clearTimeout(timer);
      resizeObserver.disconnect();
    };
  }, []);

  // Initialize paint canvas at fixed virtual size (must run before engine init)
  useLayoutEffect(() => {
    const canvas = paintCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (canvas.width !== VIRTUAL_CANVAS_WIDTH || canvas.height !== VIRTUAL_CANVAS_HEIGHT) {
      canvas.width = VIRTUAL_CANVAS_WIDTH;
      canvas.height = VIRTUAL_CANVAS_HEIGHT;
      ctx.fillStyle = MURAL_BACKGROUND_COLOR;
      ctx.fillRect(0, 0, VIRTUAL_CANVAS_WIDTH, VIRTUAL_CANVAS_HEIGHT);
    }
  }, []);

  // Paint engine (WebGL)
  const {
    containerRef: engineContainerRef,
    initEngine,
    engine,
    showImpasto,
    setShowImpasto,
    applyImpasto,
    smearHeight,
    scrapeHeight,
    clearHeightMap,
    markDirty,
  } = usePaintEngine(containerSize, viewport, paintCanvasRef, isDrawing);

  // Initialize three.js engine when container mounts
  useEffect(() => {
    if (engineContainerRef.current && !engine) {
      initEngine(engineContainerRef.current);
    }
  }, [engineContainerRef.current, engine, initEngine]);

  // Process pending impasto strokes
  useEffect(() => {
    if (!applyImpasto || pendingImpasto.current.length === 0) return;

    const strokes = pendingImpasto.current.splice(0);
    for (const s of strokes) {
      applyImpasto(s.points, s.size, s.paintType, s.opacity);
    }
  }, [engine, applyImpasto]);

  // Process pending smears
  useEffect(() => {
    if (!smearHeight || pendingSmear.current.length === 0) return;

    const smears = pendingSmear.current.splice(0);
    for (const s of smears) {
      smearHeight(s.points, s.size, s.strength);
    }
  }, [engine, smearHeight]);

  // WebSocket hook
  const {
    ws,
    connected,
    sendStroke: wsSendStroke,
    sendStrokeLive: wsSendStrokeLive,
    sendClear: wsSendClear,
    sendChat: wsSendChat,
  } = useWebSocket(roomId);

  const isCanvasReady = true;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('mural', roomId);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/murals/${encodeURIComponent(roomId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setMuralSavedAt(data.updatedAt || null);
        setMuralStatus(data.strokeCount > 0
          ? `${data.strokeCount} saved marks on this mural`
          : 'Blank mural. Make the first mark.');
      })
      .catch(() => {
        if (!cancelled) setMuralStatus('Local drawing works. Server save status is unavailable.');
      });

    fetch('/api/murals')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.murals) {
          setFeaturedMurals(data.murals.slice(0, 4));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const joinMural = useCallback(() => {
    const nextRoomId = normalizeMuralId(roomDraft);
    setRoomDraft(nextRoomId);
    setRoomId(nextRoomId);
    setMuralError('');
    setInviteCopied(false);
  }, [roomDraft]);

  const handleShareMural = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('mural', roomId);
    try {
      await navigator.clipboard?.writeText(url.toString());
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 1800);
    } catch {
      setInviteCopied(false);
    }
  }, [roomId]);

  const handleExportMural = useCallback(() => {
    const canvas = paintCanvasRef.current;
    if (!canvas) return;

    const link = document.createElement('a');
    link.download = `${roomId}-mural.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [roomId]);

  const currentPrompt = MURAL_PROMPTS[activePromptIndex % MURAL_PROMPTS.length];
  const currentBrushOption = BRUSH_OPTIONS.find((brush) => brush.value === currentBrush) || BRUSH_OPTIONS[0];
  const currentPaintLabel = PAINT_PROPERTIES[paintType]?.label || 'Standard';

  // Handle stroke live updates (throttled, sent during drawing)
  const handleStrokeLive = useCallback((liveData) => {
    if (wsSendStrokeLive) {
      wsSendStrokeLive(liveData);
    }
  }, [wsSendStrokeLive]);

  // Handle drawing end - sends stroke to WebSocket and applies impasto
  const handleDrawEnd = useCallback((stroke) => {
    setIsDrawing(false);
    markDirty();
    if (stroke && stroke.points && stroke.points.length > 0 && ws && connected) {
      // Send stroke over WebSocket
      wsSendStroke(stroke);
      const now = Date.now();
      setMuralSavedAt(now);
      setMuralStatus('Saving this mark to the mural wall...');
      setTimeout(() => {
        setMuralStatus(formatSavedAt(now));
      }, 700);

      // Apply local impasto for paint types
      if (applyImpasto && stroke.paintType && stroke.paintType !== PAINT_TYPES.NONE) {
        if (stroke.type === BRUSH_TYPES.PALETTE_KNIFE && smearHeight) {
          pendingSmear.current.push({
            points: stroke.points,
            size: stroke.size,
            strength: 0.5,
          });
        } else if (stroke.type === BRUSH_TYPES.BLUR && smearHeight) {
          pendingSmear.current.push({
            points: stroke.points,
            size: stroke.size,
            strength: 0.3,
          });
        } else if (stroke.type === BRUSH_TYPES.SMUDGE && smearHeight) {
          pendingSmear.current.push({
            points: stroke.points,
            size: stroke.size,
            strength: 0.4,
          });
        } else if (stroke.type === BRUSH_TYPES.ERASER && scrapeHeight) {
          scrapeHeight(stroke.points, stroke.size);
        } else {
          pendingImpasto.current.push({
            points: stroke.points,
            size: stroke.size,
            paintType: stroke.paintType,
            opacity: stroke.opacity,
          });
        }
      }
    }
  }, [ws, connected, wsSendStroke, applyImpasto, smearHeight, scrapeHeight]);

  // Chat brush: canvas → screen position conversion
  const canvasToScreen = useCallback((cx, cy) => {
    const w = containerSize.width;
    const h = containerSize.height;
    const sx = (cx - viewport.x) * viewport.zoom + w / 2;
    const sy = (cy - viewport.y) * viewport.zoom + h / 2;
    return { x: sx, y: sy };
  }, [viewport, containerSize]);

  // Chat brush: handle a new chat thread at canvas position
  const handleChatThreadCreate = useCallback((canvasX, canvasY) => {
    const threadId = `thread-${Date.now()}-${userName || 'anon'}`;
    const thread = { id: threadId, x: canvasX, y: canvasY, messages: [] };
    setChatThreads((prev) => [...prev, thread]);
    setActiveReplyId(threadId);
    setTimeout(() => chatBrushInputRef.current?.focus(), 50);

    if (ws && connected) {
      ws.send(JSON.stringify({ type: 'chat_thread_create', thread }));
    }
  }, [userName, ws, connected]);

  // Chat brush: send a message to active thread
  const handleChatBrushSend = useCallback(() => {
    const text = chatBrushInput.trim();
    if (!text || !activeReplyId) return;

    const msg = {
      id: `msg-${Date.now()}`,
      user: userName || 'You',
      color: userColor || '#4ECDC4',
      text,
      timestamp: Date.now(),
    };

    setChatThreads((prev) =>
      prev.map((t) =>
        t.id === activeReplyId
          ? { ...t, messages: [...t.messages, msg] }
          : t
      )
    );

    if (ws && connected) {
      ws.send(JSON.stringify({
        type: 'chat_thread_msg',
        threadId: activeReplyId,
        message: msg,
      }));
    }

    setChatBrushInput('');
    setActiveReplyId(null);
  }, [chatBrushInput, activeReplyId, userName, userColor, ws, connected]);

  const drawMemeStamp = useCallback((meme, options = {}) => {
    const { addAnimatedOverlay = true } = options;
    const canvas = paintCanvasRef.current;
    if (!canvas || !meme?.url) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      const center = getMemeCenter(meme);
      ctx.save();
      ctx.globalAlpha = meme.opacity ?? 0.92;
      ctx.translate(center.x, center.y);
      ctx.rotate(meme.rotation || 0);
      ctx.drawImage(img, -meme.width / 2, -meme.height / 2, meme.width, meme.height);
      ctx.restore();
      markDirty();

      if (meme.animated && addAnimatedOverlay) {
        setMemes((prev) => {
          if (prev.some((item) => item.id === meme.id)) return prev;
          return [...prev, meme];
        });
      }
    };
    img.src = meme.url;
  }, [markDirty]);

  const publishMemeStamp = useCallback((meme) => {
    drawMemeStamp(meme);
    setMuralSavedAt(Date.now());
    setMuralStatus(meme.animated
      ? 'Stamped the first frame. Animation stays as a tracing layer.'
      : 'Stamped an image onto the mural.');

    if (ws && connected) {
      ws.send(JSON.stringify({
        type: 'meme',
        meme,
      }));
    }
  }, [connected, drawMemeStamp, ws]);

  const buildMemeStampFromDrag = useCallback((start, end, source) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const width = Math.max(MIN_MEME_STAMP_SIZE, distance > 8 ? distance * 2 : 220);
    const aspectRatio = source.aspectRatio || 1;
    const height = Math.max(MIN_MEME_STAMP_SIZE, width / aspectRatio);
    const rotation = distance > 8 ? Math.atan2(dy, dx) : 0;

    return {
      id: `meme-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      centerX: start.x,
      centerY: start.y,
      x: start.x - width / 2,
      y: start.y - height / 2,
      width,
      height,
      rotation,
      url: source.url,
      animated: source.animated,
      opacity: 0.92,
      name: source.name,
    };
  }, []);

  const handleMemeGesture = useCallback((canvasX, canvasY, eventInfo = {}) => {
    const phase = eventInfo.phase || 'start';

    if (!memeStampSource) {
      if (phase === 'start') {
        memePendingPos.current = { x: canvasX, y: canvasY };
        setMuralStatus('Choose an image, then drag on the mural to size and rotate it.');
        memeFileRef.current?.click();
      }
      return false;
    }

    if (phase === 'start') {
      const start = { x: canvasX, y: canvasY };
      memeDragStart.current = start;
      setMemePreview(buildMemeStampFromDrag(start, start, memeStampSource));
      return true;
    }

    if (!memeDragStart.current) return false;

    const stamp = buildMemeStampFromDrag(
      memeDragStart.current,
      { x: canvasX, y: canvasY },
      memeStampSource
    );

    if (phase === 'move') {
      setMemePreview(stamp);
      return true;
    }

    if (phase === 'end') {
      publishMemeStamp(stamp);
      setMemePreview(null);
      memeDragStart.current = null;
      return true;
    }

    return false;
  }, [buildMemeStampFromDrag, memeStampSource, publishMemeStamp]);

  // Handle meme file selection
  const handleMemeFile = useCallback((e) => {
    const file = e.target.files?.[0];
    const targetPos = memePendingPos.current;
    if (!file || !targetPos) return;

    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      const img = new Image();
      img.onload = () => {
        const maxDim = 360;
        let w = img.naturalWidth || maxDim;
        let h = img.naturalHeight || maxDim;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const source = {
          url,
          animated: /gif|webp/i.test(file.type),
          name: file.name,
          aspectRatio: w / h,
        };

        setMemeStampSource(source);
        setMemePreview(buildMemeStampFromDrag(targetPos, targetPos, source));
        setMuralStatus('Image loaded. Press and drag on the mural to size and rotate it, then release.');

        memePendingPos.current = null;
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, [buildMemeStampFromDrag]);

  // Drawing hook - wires into the paint canvas
  const drawingState = useDrawing(
    paintCanvasRef,
    currentBrush,
    brushSize,
    selectedColor,
    brushOpacity,
    brushVariation,
    isCanvasReady,
    paintType,
    handleDrawEnd,
    () => setIsDrawing(true),
    viewportRef,
    PAINT_MIN_ZOOM,
    handleChatThreadCreate,
    handleMemeGesture,
    handleStrokeLive
  );

  const { isEraser } = drawingState || {};

  // Handle WebSocket events
  useEffect(() => {
    if (!ws) return;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'connected':
            setUserName(data.userName);
            setUserColor(data.userColor);
            setMuralSavedAt(data.updatedAt || null);
            setMuralStatus(data.strokeCount > 0
              ? `${data.strokeCount} saved marks on this mural`
              : 'Blank mural. Make the first mark.');
            break;

          case 'room_full':
            setMuralError(data.message || 'This mural is full right now.');
            break;

          case 'userList':
            setUsers(data.users);
            break;

          case 'userJoined':
            setUsers(data.userList);
            break;

          case 'userLeft':
            setUsers(data.userList);
            break;

          case 'history':
            if (paintCanvasRef.current && isCanvasReady) {
              const ctx = paintCanvasRef.current.getContext('2d');
              if (!ctx) break;
              ctx.clearRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              ctx.fillStyle = MURAL_BACKGROUND_COLOR;
              ctx.fillRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              if (clearHeightMap) clearHeightMap();

              data.history.forEach((item) => {
                if (item.type === 'stroke' && item.stroke) {
                  replayStroke(ctx, item.stroke);
                } else if (item.type === 'meme' && item.meme) {
                  drawMemeStamp(item.meme);
                }
              });
              markDirty();
              setMuralSavedAt(Date.now());
              setMuralStatus(`Replayed ${data.history.length} saved marks`);
            }
            break;

          case 'stroke_live':
            if (paintCanvasRef.current && isCanvasReady && data.stroke && data.strokeId) {
              const ctx = paintCanvasRef.current.getContext('2d');
              if (!ctx) break;

              // Accumulate points from live updates
              let live = remoteLiveStrokes.current.get(data.strokeId);
              if (!live) {
                live = {
                  points: [],
                  type: data.stroke.type,
                  color: data.stroke.color,
                  size: data.stroke.size,
                  opacity: data.stroke.opacity,
                  variation: data.stroke.variation,
                  paintType: data.stroke.paintType,
                };
                remoteLiveStrokes.current.set(data.strokeId, live);
              }

              // Draw only the new points
              if (data.stroke.points) {
                for (const p of data.stroke.points) {
                  live.points.push(p);
                }
                drawRemoteLivePoints(ctx, live, data.stroke.points);
              }
              markDirty();
            }
            break;

          case 'stroke':
            if (paintCanvasRef.current && isCanvasReady && data.stroke) {
              const ctx = paintCanvasRef.current.getContext('2d');
              if (!ctx) break;

              // Clean up any in-progress live stroke tracking
              if (data.strokeId) {
                remoteLiveStrokes.current.delete(data.strokeId);
              }

              drawRemoteStroke(ctx, data.stroke);
              markDirty();
              setMuralSavedAt(data.timestamp || Date.now());
              setMuralStatus(`${data.user?.name || 'Someone'} added to the mural`);
            }
            break;

          case 'meme':
            if (data.meme) {
              drawMemeStamp(data.meme);
              setMuralSavedAt(data.timestamp || Date.now());
              setMuralStatus(`${data.user?.name || 'Someone'} stamped an image onto the mural`);
            }
            break;

          case 'clear':
            if (paintCanvasRef.current && isCanvasReady) {
              const ctx = paintCanvasRef.current.getContext('2d');
              if (!ctx) break;
              ctx.clearRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              ctx.fillStyle = MURAL_BACKGROUND_COLOR;
              ctx.fillRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              if (clearHeightMap) clearHeightMap();
              remoteLiveStrokes.current.clear();
              setMemes([]);
              setMemePreview(null);
              markDirty();
            }
            break;

          case 'chat_thread_msg':
            if (data.threadId && data.message) {
              setChatThreads((prev) =>
                prev.map((t) =>
                  t.id === data.threadId
                    ? { ...t, messages: [...t.messages, data.message] }
                    : t
                )
              );
            }
            break;

          case 'chat_thread_create':
            if (data.thread) {
              setChatThreads((prev) => {
                if (prev.find((t) => t.id === data.thread.id)) return prev;
                return [...prev, data.thread];
              });
            }
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('Error processing WebSocket message:', err);
      }
    };

    ws.onclose = () => {};
    ws.onopen = () => {};

    return () => {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onopen = null;
    };
  }, [ws, paintCanvasRef, isCanvasReady, clearHeightMap, drawMemeStamp]);

  // Replay stored stroke
  function replayStroke(ctx, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();
    ctx.strokeStyle = stroke.color || '#000000';
    ctx.fillStyle = stroke.color || '#000000';
    ctx.lineWidth = stroke.size || 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = stroke.opacity || 1;

    if (stroke.type === BRUSH_TYPES.LINE) {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    } else if (stroke.type === BRUSH_TYPES.ERASER) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    } else if (stroke.type === BRUSH_TYPES.PALETTE_KNIFE) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.globalAlpha = (stroke.opacity || 1) * 0.5;
        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (stroke.size || 10) * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (stroke.type === BRUSH_TYPES.AIRBRUSH || stroke.type === BRUSH_TYPES.WET_BRUSH) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawAirbrushOnCanvas(ctx, p.x, p.y, stroke.size || 30, stroke.opacity || 1, stroke.color, stroke.variation || 0.3);
      }
    } else if (stroke.type === BRUSH_TYPES.SPONGE) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawSpongeOnCanvas(ctx, p.x, p.y, stroke.size || 22, stroke.opacity || 1, stroke.color, stroke.variation || 0.3);
      }
    } else if (stroke.type === BRUSH_TYPES.BLUR || stroke.type === BRUSH_TYPES.SMUDGE) {
      ctx.fillStyle = stroke.color;
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.globalAlpha = (stroke.opacity || 0.5) * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (stroke.size || 30) * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawPointOnCanvas(ctx, p.x, p.y, stroke.type, stroke.size, stroke.color, stroke.opacity || 1, stroke.variation || 0.2);
      }
    }

    // Apply impasto for remote strokes
    if (stroke.paintType && stroke.paintType !== PAINT_TYPES.NONE && applyImpasto && stroke.type !== BRUSH_TYPES.ERASER && stroke.type !== BRUSH_TYPES.BLUR && stroke.type !== BRUSH_TYPES.SMUDGE) {
      pendingImpasto.current.push({
        points: stroke.points,
        size: stroke.size,
        paintType: stroke.paintType,
        opacity: stroke.opacity,
      });
    }

    ctx.restore();
  }

  // Draw incremental live stroke points from another user
  function drawRemoteLivePoints(ctx, live, newPoints) {
    if (!newPoints || newPoints.length === 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = live.color || '#000000';
    ctx.fillStyle = live.color || '#000000';
    ctx.lineWidth = live.size || 8;
    ctx.globalAlpha = live.opacity || 1;

    if (live.type === BRUSH_TYPES.ERASER) {
      ctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < newPoints.length; i++) {
        const p = newPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, (live.size || 8) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else if (live.type === BRUSH_TYPES.PALETTE_KNIFE) {
      ctx.globalAlpha = (live.opacity || 1) * 0.5;
      for (let i = 0; i < newPoints.length; i++) {
        const p = newPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, (live.size || 10) * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (live.type === BRUSH_TYPES.BLUR || live.type === BRUSH_TYPES.SMUDGE) {
      ctx.globalAlpha = (live.opacity || 0.5) * 0.4;
      for (let i = 0; i < newPoints.length; i++) {
        const p = newPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, (live.size || 30) * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // ROUND, PEN, SQUARE, PENCIL, SPRAY, AIRBRUSH, WET_BRUSH, SPONGE
      // Draw thick connected line AND circles at each point for smooth overlap
      const allPoints = live.points;
      const startIdx = Math.max(0, allPoints.length - newPoints.length - 1);
      ctx.beginPath();
      if (startIdx < allPoints.length) {
        ctx.moveTo(allPoints[startIdx].x, allPoints[startIdx].y);
        for (let i = startIdx + 1; i < allPoints.length; i++) {
          ctx.lineTo(allPoints[i].x, allPoints[i].y);
        }
      }
      ctx.stroke();
    }

    ctx.restore();
  }
  function drawRemoteStroke(ctx, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();
    ctx.strokeStyle = stroke.color || '#000000';
    ctx.fillStyle = stroke.color || '#000000';
    ctx.lineWidth = stroke.size || 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = stroke.opacity || 1;

    if (stroke.type === BRUSH_TYPES.LINE) {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    } else if (stroke.type === BRUSH_TYPES.ERASER) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    } else if (stroke.type === BRUSH_TYPES.PALETTE_KNIFE) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.globalAlpha = (stroke.opacity || 1) * 0.5;
        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (stroke.size || 10) * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (stroke.type === BRUSH_TYPES.AIRBRUSH || stroke.type === BRUSH_TYPES.WET_BRUSH) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawAirbrushOnCanvas(ctx, p.x, p.y, stroke.size || 30, stroke.opacity || 1, stroke.color, stroke.variation || 0.3);
      }
    } else if (stroke.type === BRUSH_TYPES.SPONGE) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawSpongeOnCanvas(ctx, p.x, p.y, stroke.size || 22, stroke.opacity || 1, stroke.color, stroke.variation || 0.3);
      }
    } else if (stroke.type === BRUSH_TYPES.BLUR || stroke.type === BRUSH_TYPES.SMUDGE) {
      ctx.fillStyle = stroke.color;
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.globalAlpha = (stroke.opacity || 0.5) * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (stroke.size || 30) * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawPointOnCanvas(ctx, p.x, p.y, stroke.type, stroke.size, stroke.color, stroke.opacity || 1, stroke.variation || 0.2);
      }
    }

    if (stroke.paintType && stroke.paintType !== PAINT_TYPES.NONE && applyImpasto && stroke.type !== BRUSH_TYPES.ERASER && stroke.type !== BRUSH_TYPES.BLUR && stroke.type !== BRUSH_TYPES.SMUDGE) {
      pendingImpasto.current.push({
        points: stroke.points,
        size: stroke.size,
        paintType: stroke.paintType,
        opacity: stroke.opacity,
      });
    }

    ctx.restore();
  }

  function drawAirbrushOnCanvas(ctx, x, y, size, opacity, color, variation) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = opacity * variation * 0.15;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = opacity * 0.03;
    for (let i = 0; i < Math.floor(size); i++) {
      const r = (Math.random() + Math.random() + Math.random()) / 3 * size * 0.6;
      const a = Math.random() * Math.PI * 2;
      const dx = x + r * Math.cos(a);
      const dy = y + r * Math.sin(a);
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(0.3, Math.random()), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSpongeOnCanvas(ctx, x, y, size, opacity, color, variation) {
    const density = Math.floor(size * variation * 2);
    ctx.globalAlpha = opacity * 0.35;

    for (let i = 0; i < density; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * size * 0.5;
      const dx = x + radius * Math.cos(angle);
      const dy = y + radius * Math.sin(angle);
      const spotSize = Math.max(1, Math.random() * size * 0.18);
      ctx.beginPath();
      ctx.arc(dx, dy, spotSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPointOnCanvas(ctx, x, y, brushType, size, color, opacity, variation) {
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    switch (brushType) {
      case BRUSH_TYPES.ROUND:
      case BRUSH_TYPES.PEN:
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        break;

      case BRUSH_TYPES.SQUARE:
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        break;

      case BRUSH_TYPES.PENCIL:
        ctx.globalAlpha = opacity * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, size * 0.15), 0, Math.PI * 2);
        ctx.fill();
        break;

      case BRUSH_TYPES.SPRAY:
        ctx.globalAlpha = opacity * 0.24;
        for (let i = 0; i < Math.floor(size * 2 * variation); i++) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * size;
          const dx = x + radius * Math.cos(angle);
          const dy = y + radius * Math.sin(angle);
          ctx.beginPath();
          ctx.arc(dx, dy, Math.max(0.5, Math.random() * 1.5), 0, Math.PI * 2);
          ctx.fill();
        }
        break;

      case BRUSH_TYPES.AIRBRUSH:
      case BRUSH_TYPES.WET_BRUSH:
        drawAirbrushOnCanvas(ctx, x, y, size, opacity, color, variation);
        break;

      case BRUSH_TYPES.SPONGE:
        drawSpongeOnCanvas(ctx, x, y, size, opacity, color, variation);
        break;

      case BRUSH_TYPES.PALETTE_KNIFE:
        ctx.globalAlpha = opacity * 0.5;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
        ctx.fill();
        break;

      case BRUSH_TYPES.BLUR:
      case BRUSH_TYPES.SMUDGE:
        ctx.globalAlpha = opacity * 0.4;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.35, 0, Math.PI * 2);
        ctx.fill();
        break;

      default:
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
    }
  }

  // Handle clear canvas
  const handleClear = useCallback(() => {
    if (paintCanvasRef.current) {
      const ctx = paintCanvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
      ctx.fillStyle = MURAL_BACKGROUND_COLOR;
      ctx.fillRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
    }
    if (clearHeightMap) clearHeightMap();
    remoteLiveStrokes.current.clear();
    setMemes([]);
    setMemePreview(null);
    markDirty();
    wsSendClear();
  }, [wsSendClear, clearHeightMap]);

  // Zoom via mouse wheel
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setViewport((prev) => {
      const delta = -e.deltaY * ZOOM_PER_SCROLL * 0.01;
      let newZoom = prev.zoom * (1 + delta);
      newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));

      // Zoom toward cursor: adjust pan so the point under cursor stays fixed
      const worldX = prev.x + (mouseX - rect.width / 2) / prev.zoom;
      const worldY = prev.y + (mouseY - rect.height / 2) / prev.zoom;
      const newX = worldX - (mouseX - rect.width / 2) / newZoom;
      const newY = worldY - (mouseY - rect.height / 2) / newZoom;

      return { x: newX, y: newY, zoom: newZoom };
    });
  }, []);

  // Pan state
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const spaceDown = useRef(false);

  // Keyboard for space-to-pan
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        spaceDown.current = true;
        setIsSpacePressed(true);
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        isPanning.current = false;
        setIsSpacePressed(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Pan via middle mouse or space+drag on the canvas container
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const onMouseDown = (e) => {
      if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
        e.preventDefault();
        isPanning.current = true;
        panStart.current = { x: e.clientX, y: e.clientY };
        container.style.cursor = 'grabbing';
      }
    };
    const onMouseMove = (e) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      panStart.current = { x: e.clientX, y: e.clientY };
      setViewport((prev) => ({
        ...prev,
        x: prev.x - dx / prev.zoom,
        y: prev.y - dy / prev.zoom,
      }));
    };
    const onMouseUp = () => {
      isPanning.current = false;
      container.style.cursor = '';
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Touch pinch zoom
  const pinchDist = useRef(null);
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchDist.current = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && pinchDist.current) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / pinchDist.current;
        pinchDist.current = dist;
        setViewport((prev) => ({
          ...prev,
          zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * scale)),
        }));
      }
    };
    const onTouchEnd = () => {
      pinchDist.current = null;
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd);
    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // Attach wheel handler
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Update minimap
  useEffect(() => {
    const mini = minimapCanvasRef.current;
    if (!mini) return;
    const paintCanvas = paintCanvasRef.current;
    if (!paintCanvas) return;
    const mctx = mini.getContext('2d');
    const mw = mini.width;
    const mh = mini.height;
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(paintCanvas, 0, 0, VIRTUAL_CANVAS_WIDTH, VIRTUAL_CANVAS_HEIGHT, 0, 0, mw, mh);

    // Draw viewport rectangle
    const vpW = containerSize.width / viewport.zoom;
    const vpH = containerSize.height / viewport.zoom;
    const vpX = (viewport.x - vpW / 2) / VIRTUAL_CANVAS_WIDTH * mw;
    const vpY = (viewport.y - vpH / 2) / VIRTUAL_CANVAS_HEIGHT * mh;
    const vpWmini = vpW / VIRTUAL_CANVAS_WIDTH * mw;
    const vpHmini = vpH / VIRTUAL_CANVAS_HEIGHT * mh;

    mctx.strokeStyle = '#e94560';
    mctx.lineWidth = 2;
    mctx.strokeRect(vpX, vpY, vpWmini, vpHmini);

    // Draw crosshairs at viewport center
    const cx = viewport.x / VIRTUAL_CANVAS_WIDTH * mw;
    const cy = viewport.y / VIRTUAL_CANVAS_HEIGHT * mh;
    mctx.strokeStyle = 'rgba(233,69,96,0.8)';
    mctx.lineWidth = 1;
    mctx.beginPath();
    mctx.arc(cx, cy, 4, 0, Math.PI * 2);
    mctx.stroke();
    mctx.beginPath();
    mctx.moveTo(cx - 6, cy);
    mctx.lineTo(cx + 6, cy);
    mctx.moveTo(cx, cy - 6);
    mctx.lineTo(cx, cy + 6);
    mctx.stroke();
  }, [viewport, containerSize]);

  // Handle brush change
  const handleBrushChange = useCallback((e) => {
    const brush = e.target.value;
    setCurrentBrush(brush);
    if (brush === BRUSH_TYPES.SPRAY) {
      setBrushSize(25);
    } else if (brush === BRUSH_TYPES.AIRBRUSH) {
      setBrushSize(35);
    } else if (brush === BRUSH_TYPES.PALETTE_KNIFE) {
      setBrushSize(24);
      setBrushOpacity(0.6);
    } else if (brush === BRUSH_TYPES.BLUR) {
      setBrushSize(30);
      setBrushOpacity(0.5);
    } else if (brush === BRUSH_TYPES.SMUDGE) {
      setBrushSize(18);
      setBrushOpacity(0.7);
    } else if (brush === BRUSH_TYPES.WET_BRUSH) {
      setBrushSize(14);
      setBrushOpacity(0.45);
    } else if (brush === BRUSH_TYPES.SPONGE) {
      setBrushSize(22);
      setBrushOpacity(0.5);
    } else {
      setBrushSize(8);
    }
  }, []);

  // Handle paint type change
  const handlePaintTypeChange = useCallback((e) => {
    const pt = e.target.value;
    setPaintType(pt);
    const paintProps = PAINT_PROPERTIES[pt] || PAINT_PROPERTIES[PAINT_TYPES.NONE];
    setBrushOpacity(paintProps.defaultOpacity);
  }, []);

  return (
    <div className="app-container">
      {/* Studio side panel: mural/session controls */}
      <div className={`toolbar-panel studio-panel ${showToolbar ? 'open' : 'closed'}`}>
        <div className="toolbar-header">
          <div>
            <div className="app-kicker">Shared mural studio</div>
            <h1 className="app-title">🎨 Mural Jam</h1>
          </div>
          <button
            className="toolbar-toggle"
            onClick={() => setShowToolbar(!showToolbar)}
            aria-label="Toggle toolbar"
          >
            {showToolbar ? '▶' : '💻'}
          </button>
        </div>

        {showToolbar && (
          <div className="toolbar-content">
            <div className="jam-kit-card">
              <div className="jam-kit-top">
                <span className="jam-kit-label">Jam kit</span>
                <span className={`jam-live-dot ${connected ? 'is-live' : ''}`} />
              </div>
              <div className="jam-kit-stack">
                <div className="kit-chip color-chip" style={{ '--chip-color': selectedColor }}>
                  <span className="chip-swatch" />
                  <strong>{selectedColor.toUpperCase()}</strong>
                </div>
                <div className="kit-chip">
                  <span>Tool</span>
                  <strong>{currentBrushOption.label}</strong>
                </div>
                <div className="kit-chip">
                  <span>Paint</span>
                  <strong>{currentPaintLabel}</strong>
                </div>
              </div>
            </div>

            {/* Mural selector */}
            <div className="toolbar-section mural-room-section tool-card">
              <label>🏠 Mural</label>
              <input
                type="text"
                value={roomDraft}
                onChange={(e) => setRoomDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinMural();
                }}
                placeholder="mural name"
                className="room-input"
              />
              <button className="action-btn join-btn" onClick={joinMural}>
                Join mural
              </button>
              <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
                {connected ? `✅ Live in ${roomId}` : '🔌 Reconnecting'}
              </div>
              {muralError && <div className="mural-error">{muralError}</div>}
              <div className="mural-save-status">{muralStatus}</div>
            </div>

            <div className="mural-actions sticky-actions">
              <button className="action-btn save-mural-btn" onClick={handleExportMural}>
                Save PNG
              </button>
              <button className="action-btn share-mural-btn" onClick={handleShareMural}>
                {inviteCopied ? 'Copied' : 'Invite'}
              </button>
            </div>

            <div className="mural-prompt-card">
              <div className="prompt-label">Wall prompt</div>
              <button
                type="button"
                className="prompt-refresh"
                onClick={() => setActivePromptIndex((idx) => idx + 1)}
                aria-label="Try another mural prompt"
              >
                ↻
              </button>
              <p>{currentPrompt}</p>
            </div>

            {/* Actions */}
            <div className="toolbar-actions">
              <button className="action-btn clear-btn" onClick={handleClear}>
                Clear mural 🧹
              </button>
            </div>

            {/* User list toggle */}
            <button
              className="action-btn user-list-btn"
              onClick={() => setShowUserList(!showUserList)}
            >
              👥 Artists ({users.length}/{MAX_MURAL_ARTISTS})
            </button>

            {showUserList && (
              <div className="studio-artists">
                <UserList users={users} currentUserId={userName ? userName : ''} />
              </div>
            )}

            {/* Layer visibility toggles */}
            <div className="toolbar-section layer-toggles">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showChatThreads}
                  onChange={(e) => setShowChatThreads(e.target.checked)}
                />
                Show Chat 💬
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showMemes}
                  onChange={(e) => setShowMemes(e.target.checked)}
                />
                Show Memes 🖼️
              </label>
            </div>

            {featuredMurals.length > 0 && (
              <div className="toolbar-section recent-murals">
                <label>🧭 Recent Murals</label>
                {featuredMurals.map((mural) => (
                  <button
                    key={mural.id}
                    type="button"
                    className={`recent-mural-btn ${mural.id === roomId ? 'active' : ''}`}
                    onClick={() => {
                      setRoomDraft(mural.id);
                      setRoomId(mural.id);
                    }}
                  >
                    <span>{mural.id}</span>
                    <small>{mural.strokeCount} marks</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom painter palette: creative controls */}
      <div className="painter-palette" aria-label="Painter palette">
        <div className="palette-board">
          <div className="palette-grip" aria-hidden="true" />
          <div className="palette-thumb-hole" aria-hidden="true" />

          <div className="palette-status">
            <span className="palette-status-label">Loaded brush</span>
            <strong>{currentBrushOption.label}</strong>
            <span
              className="palette-status-swatch"
              style={{ '--chip-color': selectedColor }}
              aria-hidden="true"
            />
          </div>

          <div className="palette-section paint-type-card">
            <label>Paint</label>
            <PaintTypeSelector
              currentPaintType={paintType}
              onPaintTypeChange={handlePaintTypeChange}
            />
          </div>

          <div className="palette-section brush-card">
            <label>Brush</label>
            <BrushSelector
              currentBrush={currentBrush}
              onBrushChange={handleBrushChange}
              options={BRUSH_OPTIONS}
            />
          </div>

          <div className="palette-section color-card palette-colors">
            <label>Color puddles</label>
            <ColorSelector onColorSelect={setSelectedColor} selectedColor={selectedColor} />
          </div>

          <div className="palette-section range-card palette-sliders">
            <label>Size {brushSize}px</label>
            <input
              type="range"
              min={
                currentBrush === BRUSH_TYPES.BLUR ? '10' :
                currentBrush === BRUSH_TYPES.AIRBRUSH ? '10' :
                currentBrush === BRUSH_TYPES.SPRAY ? '5' : '1'
              }
              max={
                currentBrush === BRUSH_TYPES.BLUR ? '150' :
                currentBrush === BRUSH_TYPES.SMUDGE ? '120' :
                currentBrush === BRUSH_TYPES.AIRBRUSH ? '120' :
                currentBrush === BRUSH_TYPES.SPRAY ? '300' : '80'
              }
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="size-slider"
            />
            <label>Opacity {Math.round(brushOpacity * 100)}%</label>
            <input
              type="range"
              min="5"
              max="100"
              value={Math.round(brushOpacity * 100)}
              onChange={(e) => setBrushOpacity(Number(e.target.value) / 100)}
              className="size-slider"
            />
            {(currentBrush === BRUSH_TYPES.SPRAY || currentBrush === BRUSH_TYPES.AIRBRUSH || currentBrush === BRUSH_TYPES.SPONGE || currentBrush === BRUSH_TYPES.WET_BRUSH) && (
              <>
                <label>Density {Math.round(brushVariation * 100)}%</label>
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={Math.round(brushVariation * 100)}
                  onChange={(e) => setBrushVariation(Number(e.target.value) / 100)}
                  className="size-slider"
                />
              </>
            )}
          </div>

          <div className="palette-section palette-specials">
            {paintType !== PAINT_TYPES.NONE && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showImpasto}
                  onChange={(e) => setShowImpasto(e.target.checked)}
                />
                3D strokes ✨
              </label>
            )}

            {currentBrush === BRUSH_TYPES.MEME && (
              <div className="meme-stamp-tools">
                <label>Stamp image</label>
                <div className="meme-stamp-current">
                  {memeStampSource ? memeStampSource.name || 'Image loaded' : 'No image selected'}
                </div>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => {
                    memePendingPos.current = {
                      x: viewportRef.current.x,
                      y: viewportRef.current.y,
                    };
                    memeFileRef.current?.click();
                  }}
                >
                  {memeStampSource ? 'Change image' : 'Choose image'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main canvas area */}
      <div className="canvas-area" ref={canvasContainerRef}>
        {/* WebGL/Three.js rendering container */}
        <div ref={engineContainerRef} className="webgl-canvas" />

        {/* Hidden 2D paint canvas for stroke rendering */}
        <canvas
          ref={paintCanvasRef}
          className="paint-canvas"
          width={VIRTUAL_CANVAS_WIDTH}
          height={VIRTUAL_CANVAS_HEIGHT}
          style={{
            touchAction: 'none',
            pointerEvents: isSpacePressed ? 'none' : 'auto',
            cursor: currentBrush === BRUSH_TYPES.ERASER
              ? 'crosshair'
              : currentBrush === BRUSH_TYPES.PALETTE_KNIFE
              ? 'grabbing'
              : currentBrush === BRUSH_TYPES.BLUR
              ? 'cell'
              : currentBrush === BRUSH_TYPES.SMUDGE
              ? 'pointer'
              : currentBrush === BRUSH_TYPES.CHAT
              ? 'cell'
              : 'crosshair',
          }}
        />

        <div className="mural-hud">
          <div>
            <span className="mural-hud-label">Mural</span>
            <strong>{roomId}</strong>
          </div>
          <div className="mural-hud-meta">
            <span>{users.length}/{MAX_MURAL_ARTISTS} artists</span>
            <span>{formatSavedAt(muralSavedAt)}</span>
          </div>
        </div>

        <div className="prompt-strip">
          <span>Try:</span>
          <button type="button" onClick={() => setActivePromptIndex((idx) => idx + 1)}>
            {currentPrompt}
          </button>
        </div>

        {/* Eraser indicator */}
        {isEraser && (
          <div className="eraser-indicator">
            Eraser: {brushSize}px 🧹
          </div>
        )}

        {/* Drawing indicator */}
        {isDrawing && (
          <div className="drawing-indicator">
            Drawing... 🎨
          </div>
        )}

        {/* Paint type indicator */}
        {paintType !== PAINT_TYPES.NONE && (
          <div className="paint-type-indicator">
            {PAINT_PROPERTIES[paintType]?.label} {showImpasto ? '3D' : ''}
          </div>
        )}

        {/* Zoom indicator */}
        <div className="zoom-indicator">
          {Math.round(viewport.zoom * 100)}%
        </div>

        {/* Paint disabled hint (zoom too far out) */}
        {viewport.zoom < PAINT_MIN_ZOOM && (
          <div className="zoom-hint">
            Zoom in to paint
          </div>
        )}

        {currentBrush === BRUSH_TYPES.MEME && viewport.zoom >= PAINT_MIN_ZOOM && (
          <div className="meme-brush-hint">
            {memeStampSource
              ? 'Press and drag to size and rotate the image. Release to stamp it, then paint over it.'
              : 'Tap the mural to choose an image. After it loads, drag to size and rotate it.'}
          </div>
        )}

        {/* Minimap with zoom controls */}
        <div className="minimap-container">
          <canvas
            ref={minimapCanvasRef}
            width={180}
            height={120}
            className="minimap"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = (e.clientX - rect.left) / rect.width;
              const my = (e.clientY - rect.top) / rect.height;
              setViewport((prev) => ({
                ...prev,
                x: mx * VIRTUAL_CANVAS_WIDTH,
                y: my * VIRTUAL_CANVAS_HEIGHT,
              }));
            }}
          />
          <div className="minimap-zoom-controls">
            <button
              className="minimap-zoom-btn"
              onClick={() => setViewport((prev) => ({
                ...prev,
                zoom: Math.min(MAX_ZOOM, prev.zoom * 1.4),
              }))}
              title="Zoom in"
            >+</button>
            <button
              className="minimap-zoom-btn"
              onClick={() => setViewport((prev) => ({
                ...prev,
                zoom: Math.max(MIN_ZOOM, prev.zoom / 1.4),
              }))}
              title="Zoom out"
            >−</button>
          </div>
        </div>

        {/* Chat brush threads overlay */}
        {showChatThreads && chatThreads.map((thread) => {
          const screen = canvasToScreen(thread.x, thread.y);
          return (
            <div
              key={thread.id}
              className="chat-thread"
              style={{
                left: screen.x,
                top: screen.y,
                transform: `scale(${Math.min(1, viewport.zoom)})`,
                transformOrigin: 'top left',
              }}
            >
              {thread.messages.map((msg) => (
                <div key={msg.id} className="chat-bubble">
                  <span className="chat-bubble-user" style={{ color: msg.color }}>
                    {msg.user}
                  </span>
                  <span className="chat-bubble-text">{msg.text}</span>
                </div>
              ))}
              {activeReplyId === thread.id ? (
                <div className="chat-bubble-input">
                  <input
                    ref={chatBrushInputRef}
                    type="text"
                    value={chatBrushInput}
                    onChange={(e) => setChatBrushInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleChatBrushSend();
                      if (e.key === 'Escape') setActiveReplyId(null);
                    }}
                    placeholder="Add a line..."
                    className="chat-thread-input"
                  />
                </div>
              ) : (
                <button
                  className="chat-bubble-reply"
                  onClick={() => {
                    setActiveReplyId(thread.id);
                    setTimeout(() => chatBrushInputRef.current?.focus(), 50);
                  }}
                >
                  + reply
                </button>
              )}
            </div>
          );
        })}

        {/* Meme/GIF overlays — only render when visible layer is on */}
        {memePreview && (() => {
          const center = getMemeCenter(memePreview);
          const screen = canvasToScreen(center.x, center.y);
          return (
            <div
              className="meme-overlay meme-preview"
              style={{
                left: screen.x,
                top: screen.y,
                width: memePreview.width * viewport.zoom,
                height: memePreview.height * viewport.zoom,
                transform: `translate(-50%, -50%) rotate(${memePreview.rotation || 0}rad)`,
              }}
            >
              <img
                src={memePreview.url}
                alt="Meme stamp preview"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                draggable={false}
              />
            </div>
          );
        })()}

        {showMemes && memes.map((meme) => {
          const center = getMemeCenter(meme);
          const screen = canvasToScreen(center.x, center.y);
          const isVisible = (
            screen.x > -meme.width &&
            screen.x < containerSize.width + meme.width &&
            screen.y > -meme.height &&
            screen.y < containerSize.height + meme.height
          );
          if (!isVisible) return null;
          return (
            <div
              key={meme.id}
              className="meme-overlay animated-reference"
              style={{
                left: screen.x,
                top: screen.y,
                width: meme.width * viewport.zoom,
                height: meme.height * viewport.zoom,
                transform: `translate(-50%, -50%) rotate(${meme.rotation || 0}rad)`,
              }}
            >
              <img
                src={meme.url}
                alt="Animated tracing reference"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                draggable={false}
              />
            </div>
          );
        })}

        {/* Hidden file input for meme uploads */}
        <input
          ref={memeFileRef}
          type="file"
          accept="image/gif,image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={handleMemeFile}
        />
      </div>
    </div>
  );
}

export default App;
