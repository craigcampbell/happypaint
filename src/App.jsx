import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import './App.css';
import { usePaintEngine } from './hooks/usePaintEngine';
import { useDrawing } from './hooks/useDrawing';
import { useWebSocket } from './hooks/useWebSocket';

import ColorSelector from './components/ColorSelector';
import BrushSelector from './components/BrushSelector';
import PaintTypeSelector from './components/PaintTypeSelector';
import UserList from './components/UserList';
import { BRUSH_TYPES, DEFAULT_PAINT_TYPE, VIRTUAL_CANVAS_WIDTH, VIRTUAL_CANVAS_HEIGHT, MIN_ZOOM, MAX_ZOOM, ZOOM_PER_SCROLL, PAINT_MIN_ZOOM } from './utils/constants';
import { PAINT_TYPES, PAINT_PROPERTIES } from './utils/paintTypes';

const BRUSH_OPTIONS = [
  { value: BRUSH_TYPES.ROUND, label: '🖌️ Brush' },
  { value: BRUSH_TYPES.SQUARE, label: '⬜ Square' },
  { value: BRUSH_TYPES.SPRAY, label: '💨 Spray' },
  { value: BRUSH_TYPES.AIRBRUSH, label: '☁️ Airbrush' },
  { value: BRUSH_TYPES.PENCIL, label: '✏️ Pencil' },
  { value: BRUSH_TYPES.PEN, label: '🖊️ Pen' },
  { value: BRUSH_TYPES.LINE, label: '📏 Line' },
  { value: BRUSH_TYPES.PALETTE_KNIFE, label: '🔪 Palette Knife' },
  { value: BRUSH_TYPES.ERASER, label: '🧹 Eraser' },
  { value: BRUSH_TYPES.CHAT, label: '💬 Chat' },
  { value: BRUSH_TYPES.MEME, label: '🖼️ Meme' },
];

function App() {
  const [currentBrush, setCurrentBrush] = useState(BRUSH_TYPES.ROUND);
  const [brushSize, setBrushSize] = useState(8);
  const [brushOpacity, setBrushOpacity] = useState(1);
  const [selectedColor, setSelectedColor] = useState('#1a1a2e');
  const [paintType, setPaintType] = useState(DEFAULT_PAINT_TYPE);
  const [showToolbar, setShowToolbar] = useState(true);
  const [showUserList, setShowUserList] = useState(true);
  const [users, setUsers] = useState([]);
  const [roomId, setRoomId] = useState('main');
  const [userName, setUserName] = useState('');
  const [userColor, setUserColor] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushVariation, setBrushVariation] = useState(0.2);
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  // Chat brush threads: {id, x, y, messages: [{id, user, color, text, timestamp}]}
  const [chatThreads, setChatThreads] = useState([]);
  const [activeReplyId, setActiveReplyId] = useState(null); // thread id being replied to
  const [chatBrushInput, setChatBrushInput] = useState('');
  const chatBrushInputRef = useRef(null);

  // Meme brush: {id, x, y, width, height, url}
  const [memes, setMemes] = useState([]);
  const [showMemes, setShowMemes] = useState(true);
  const [showChatThreads, setShowChatThreads] = useState(true);
  const memeFileRef = useRef(null);
  const memePendingPos = useRef(null);

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
      ctx.fillStyle = '#ffffff';
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
    sendClear: wsSendClear,
    sendChat: wsSendChat,
  } = useWebSocket(roomId);

  const isCanvasReady = true;

  // Handle drawing end - sends stroke to WebSocket and applies impasto
  const handleDrawEnd = useCallback((stroke) => {
    setIsDrawing(false);
    markDirty();
    if (stroke && stroke.points && stroke.points.length > 0 && ws && connected) {
      // Send stroke over WebSocket
      wsSendStroke(stroke);

      // Apply local impasto for paint types
      if (applyImpasto && stroke.paintType && stroke.paintType !== PAINT_TYPES.NONE) {
        if (stroke.type === BRUSH_TYPES.PALETTE_KNIFE && smearHeight) {
          pendingSmear.current.push({
            points: stroke.points,
            size: stroke.size,
            strength: 0.5,
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

  // Handle meme file selection
  const handleMemeFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file || !memePendingPos.current) return;

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxDim = 300;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      setMemes((prev) => [
        ...prev,
        {
          id: `meme-${Date.now()}`,
          x: memePendingPos.current.x - w / 2,
          y: memePendingPos.current.y - h / 2,
          width: w,
          height: h,
          url,
        },
      ]);
      memePendingPos.current = null;
    };
    img.src = url;
    e.target.value = '';
  }, []);

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
    (canvasX, canvasY) => {
      memePendingPos.current = { x: canvasX, y: canvasY };
      memeFileRef.current?.click();
    }
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
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              if (clearHeightMap) clearHeightMap();

              data.history.forEach((item) => {
                if (item.type === 'stroke' && item.stroke) {
                  replayStroke(ctx, item.stroke);
                }
              });
              markDirty();
            }
            break;

          case 'stroke':
            if (paintCanvasRef.current && isCanvasReady && data.stroke) {
              const ctx = paintCanvasRef.current.getContext('2d');
              if (!ctx) break;
              drawRemoteStroke(ctx, data.stroke);
              markDirty();
            }
            break;

          case 'clear':
            if (paintCanvasRef.current && isCanvasReady) {
              const ctx = paintCanvasRef.current.getContext('2d');
              if (!ctx) break;
              ctx.clearRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
              if (clearHeightMap) clearHeightMap();
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
  }, [ws, paintCanvasRef, isCanvasReady, clearHeightMap]);

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
    } else if (stroke.type === BRUSH_TYPES.AIRBRUSH) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawAirbrushOnCanvas(ctx, p.x, p.y, stroke.size || 30, stroke.opacity || 1, stroke.color, stroke.variation || 0.3);
      }
    } else {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawPointOnCanvas(ctx, p.x, p.y, stroke.type, stroke.size, stroke.color, stroke.opacity || 1, stroke.variation || 0.2);
      }
    }

    // Apply impasto for remote strokes
    if (stroke.paintType && stroke.paintType !== PAINT_TYPES.NONE && applyImpasto && stroke.type !== BRUSH_TYPES.ERASER) {
      pendingImpasto.current.push({
        points: stroke.points,
        size: stroke.size,
        paintType: stroke.paintType,
        opacity: stroke.opacity,
      });
    }

    ctx.restore();
  }

  // Draw remote stroke in real-time
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
    } else if (stroke.type === BRUSH_TYPES.AIRBRUSH) {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawAirbrushOnCanvas(ctx, p.x, p.y, stroke.size || 30, stroke.opacity || 1, stroke.color, stroke.variation || 0.3);
      }
    } else {
      for (let i = 0; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        drawPointOnCanvas(ctx, p.x, p.y, stroke.type, stroke.size, stroke.color, stroke.opacity || 1, stroke.variation || 0.2);
      }
    }

    if (stroke.paintType && stroke.paintType !== PAINT_TYPES.NONE && applyImpasto && stroke.type !== BRUSH_TYPES.ERASER) {
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
        drawAirbrushOnCanvas(ctx, x, y, size, opacity, color, variation);
        break;

      case BRUSH_TYPES.PALETTE_KNIFE:
        ctx.globalAlpha = opacity * 0.5;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
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
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, paintCanvasRef.current.width, paintCanvasRef.current.height);
    }
    if (clearHeightMap) clearHeightMap();
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
      setBrushSize(20);
      setBrushOpacity(0.6);
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
      {/* Left toolbar */}
      <div className={`toolbar-panel ${showToolbar ? 'open' : 'closed'}`}>
        <div className="toolbar-header">
          <h1 className="app-title">🎨 Happy Paint</h1>
          <button
            className="toolbar-toggle"
            onClick={() => setShowToolbar(!showToolbar)}
            aria-label="Toggle toolbar"
          >
            {showToolbar ? '◀' : '🎨'}
          </button>
        </div>

        {showToolbar && (
          <div className="toolbar-content">
            {/* Room selector */}
            <div className="toolbar-section">
              <label>🏠 Room</label>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="room name"
                className="room-input"
              />
              <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
                {connected ? '✅ Connected' : '🔌 Disconnected'}
              </div>
            </div>

            {/* Paint type */}
            <div className="toolbar-section">
              <label>🎨 Paint Type</label>
              <PaintTypeSelector
                currentPaintType={paintType}
                onPaintTypeChange={handlePaintTypeChange}
              />
            </div>

            {/* Color selector */}
            <div className="toolbar-section">
              <label>🌈 Color</label>
              <ColorSelector onColorSelect={setSelectedColor} selectedColor={selectedColor} />
            </div>

            {/* Brush selector */}
            <div className="toolbar-section">
              <label>🖌️ Brush</label>
              <BrushSelector
                currentBrush={currentBrush}
                onBrushChange={handleBrushChange}
                options={BRUSH_OPTIONS}
              />
            </div>

            {/* Brush size */}
            <div className="toolbar-section">
              <label>📐 Size: {brushSize}px</label>
              <input
                type="range"
                min={currentBrush === BRUSH_TYPES.AIRBRUSH ? '10' : currentBrush === BRUSH_TYPES.SPRAY ? '5' : '1'}
                max={currentBrush === BRUSH_TYPES.AIRBRUSH ? '120' : currentBrush === BRUSH_TYPES.SPRAY ? '300' : '80'}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="size-slider"
              />
            </div>

            {/* Opacity */}
            <div className="toolbar-section">
              <label>💧 Opacity: {Math.round(brushOpacity * 100)}%</label>
              <input
                type="range"
                min="5"
                max="100"
                value={Math.round(brushOpacity * 100)}
                onChange={(e) => setBrushOpacity(Number(e.target.value) / 100)}
                className="size-slider"
              />
            </div>

            {/* Spray/Airbrush density */}
            {(currentBrush === BRUSH_TYPES.SPRAY || currentBrush === BRUSH_TYPES.AIRBRUSH) && (
              <div className="toolbar-section">
                <label>✨ Density: {Math.round(brushVariation * 100)}%</label>
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={Math.round(brushVariation * 100)}
                  onChange={(e) => setBrushVariation(Number(e.target.value) / 100)}
                  className="size-slider"
                />
              </div>
            )}

            {/* Impasto toggle */}
            {paintType !== PAINT_TYPES.NONE && (
              <div className="toolbar-section">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={showImpasto}
                    onChange={(e) => setShowImpasto(e.target.checked)}
                  />
                  Show 3D Strokes ✨
                </label>
              </div>
            )}

            {/* Actions */}
            <div className="toolbar-actions">
              <button className="action-btn clear-btn" onClick={handleClear}>
                Clear 🧹
              </button>
            </div>

            {/* User list toggle */}
            <button
              className="action-btn user-list-btn"
              onClick={() => setShowUserList(!showUserList)}
            >
              👥 Friends ({users.length})
            </button>

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
          </div>
        )}
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
              : currentBrush === BRUSH_TYPES.CHAT
              ? 'cell'
              : 'crosshair',
          }}
        />

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

        {/* User list panel */}
        {showUserList && (
          <div className="user-list-panel">
            <UserList users={users} currentUserId={userName ? userName : ''} />
          </div>
        )}

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
        {showMemes && memes.map((meme) => {
          const screen = canvasToScreen(meme.x, meme.y);
          const isVisible = (
            screen.x > -meme.width &&
            screen.x < containerSize.width + meme.width &&
            screen.y > -meme.height &&
            screen.y < containerSize.height + meme.height
          );
          if (!isVisible) return null;
          const animate = viewport.zoom >= 1.0;
          return (
            <div
              key={meme.id}
              className="meme-overlay"
              style={{
                left: screen.x,
                top: screen.y,
                width: meme.width * viewport.zoom,
                height: meme.height * viewport.zoom,
              }}
            >
              {animate ? (
                <img
                  src={meme.url}
                  alt="meme"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  draggable={false}
                />
              ) : (
                <div className="meme-placeholder">
                  +{(viewport.zoom * 100).toFixed(0)}%
                </div>
              )}
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
