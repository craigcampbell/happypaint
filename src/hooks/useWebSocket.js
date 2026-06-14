import { useState, useRef, useCallback, useEffect } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

export const useWebSocket = (roomId, onMessage) => {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState([]);
  const [aiResponses, setAiResponses] = useState([]);
  const [chatHistory, setChatHistory] = useState([]);
  const reconnectTimeoutRef = useRef(null);

  // Keep the latest message handler in a ref so we can attach onmessage at
  // socket-creation time (before the server's initial burst) without
  // reconnecting whenever the handler identity changes.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // While true, an unexpected close triggers a reconnect. We flip it off for
  // intentional teardown (unmount / room switch) so we never leak a duplicate
  // socket — the bug that made one artist appear twice in the room.
  const shouldReconnectRef = useRef(true);
  const retryCountRef = useRef(0);

  const connect = useCallback(() => {
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }
    shouldReconnectRef.current = true;

    const url = `${SERVER_URL ? SERVER_URL.replace('http', 'ws') : 'ws://localhost:3001'}?room=${encodeURIComponent(roomId)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    // Attach the message handler immediately so no early message is dropped.
    ws.onmessage = (event) => onMessageRef.current?.(event);

    ws.onopen = () => {
      setConnected(true);
      retryCountRef.current = 0;
      // Send ping every 30s to keep connection alive
      ws._pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    ws.onclose = () => {
      if (ws._pingInterval) clearInterval(ws._pingInterval);
      // Ignore closes for sockets we've already replaced or intentionally closed.
      if (wsRef.current !== ws || !shouldReconnectRef.current) return;
      setConnected(false);

      const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
      retryCountRef.current += 1;
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // Connection will retry automatically via onclose
    };
  }, [roomId]);

  // Connect on mount / room change
  useEffect(() => {
    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current?._pingInterval) {
        clearInterval(wsRef.current._pingInterval);
      }
      const closing = wsRef.current;
      wsRef.current = null;
      closing?.close();
    };
  }, [connect]);

  const sendStroke = useCallback((stroke) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'stroke',
        strokeId: stroke.strokeId,
        stroke: {
          type: stroke.type,
          color: stroke.color,
          size: stroke.size,
          opacity: stroke.opacity,
          paintType: stroke.paintType,
          variation: stroke.variation,
          points: stroke.points,
        },
      }));
    }
  }, []);

  const sendStrokeLive = useCallback((strokeData) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'stroke_live',
        strokeId: strokeData.strokeId,
        stroke: {
          type: strokeData.type,
          color: strokeData.color,
          size: strokeData.size,
          opacity: strokeData.opacity,
          paintType: strokeData.paintType,
          variation: strokeData.variation,
          points: strokeData.points,
        },
      }));
    }
  }, []);

  const sendClear = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'clear' }));
    }
  }, []);

  const sendCursor = useCallback((x, y, drawing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cursor', x, y, drawing }));
    }
  }, []);

  const sendChat = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat',
        message,
      }));
    }
  }, []);

  const sendAIChat = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat_with_ai',
        message,
      }));
    }
  }, []);

  const reconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    connect();
  }, [connect]);

  return {
    ws: wsRef.current,
    connected,
    history,
    aiResponses,
    chatHistory,
    sendStroke,
    sendStrokeLive,
    sendClear,
    sendChat,
    sendCursor,
    sendAIChat,
    reconnect,
  };
};
