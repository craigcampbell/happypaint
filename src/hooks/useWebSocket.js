import { useState, useRef, useCallback, useEffect } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

export const useWebSocket = (roomId) => {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState([]);
  const [aiResponses, setAiResponses] = useState([]);
  const [chatHistory, setChatHistory] = useState([]);
  const reconnectTimeoutRef = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = `${SERVER_URL ? SERVER_URL.replace('http', 'ws') : 'ws://localhost:3001'}?room=${encodeURIComponent(roomId)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Send ping every 30s to keep connection alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

      ws._pingInterval = pingInterval;
    };

    ws.onclose = () => {
      setConnected(false);
      if (ws._pingInterval) clearInterval(ws._pingInterval);

      // Reconnect after delay
      const retryCount = wsRef.current?._retryCount || 0;
      const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
      if (wsRef.current) {
        wsRef.current._retryCount = retryCount + 1;
      }
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      // Connection will retry automatically via onclose
    };
  }, [roomId]);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current?._pingInterval) {
        clearInterval(wsRef.current._pingInterval);
      }
      wsRef.current?.close();
      wsRef.current = null;
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
    sendAIChat,
    reconnect,
  };
};
