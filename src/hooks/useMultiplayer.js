import { useCallback, useEffect, useRef, useState } from "react";

// Realtime multiplayer client. Connects to the server's /ws relay, scoped to a
// room. The consumer supplies an `onMessage(data)` handler for canvas-affecting
// events (ops / history / clear / cursors); connection status, the user roster,
// and chat are tracked here for the UI.
//
// The socket URL is derived from the page origin so it works unchanged behind
// the Cloudflare tunnel (wss://drawesome.art/ws) and in local dev. A dev page
// served by Vite on :5173 is redirected to the server on :8787.

function resolveSocketUrl(roomId, token) {
  // A signed-in user's Supabase access token rides along as a query param; the
  // server validates it (anon key only) to learn who owns/hosts the room. Empty
  // for anonymous users — sign-in is optional.
  const tokenQs = token ? `&token=${encodeURIComponent(token)}` : "";
  const override = import.meta.env.VITE_WS_URL;
  if (override) {
    return `${override}?room=${encodeURIComponent(roomId)}${tokenQs}`;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  let host = window.location.host;
  // Vite dev server runs on 5173; the websocket lives on the node server (8787).
  if (host.endsWith(":5173")) {
    host = host.replace(":5173", ":8787");
  }
  return `${proto}://${host}/ws?room=${encodeURIComponent(roomId)}${tokenQs}`;
}

export function useMultiplayer(roomId, onMessage, token) {
  const wsRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const shouldReconnectRef = useRef(true);
  const retryRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const pingTimerRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState([]);
  const [self, setSelf] = useState(null);
  const [chat, setChat] = useState([]);

  const connect = useCallback(() => {
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }
    shouldReconnectRef.current = true;

    let ws;
    try {
      ws = new WebSocket(resolveSocketUrl(roomId, token));
    } catch {
      // Malformed URL or blocked — retry shortly.
      reconnectTimerRef.current = window.setTimeout(connect, 2000);
      return;
    }
    wsRef.current = ws;

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      // UI-level bookkeeping handled here; everything else flows to the consumer.
      switch (data.type) {
        case "connected":
          setSelf({ id: data.userId, name: data.userName, color: data.userColor });
          break;
        case "userList":
          setUsers(data.users || []);
          break;
        case "userJoined":
        case "userLeft":
          if (data.userList) setUsers(data.userList);
          break;
        case "chat":
          setChat((current) => [...current.slice(-49), data]);
          break;
        case "chat_history":
          // Server catch-up on join: seed the log with recent messages.
          setChat(Array.isArray(data.messages) ? data.messages.slice(-50) : []);
          break;
        default:
          break;
      }
      onMessageRef.current?.(data);
    };

    ws.onopen = () => {
      setConnected(true);
      retryRef.current = 0;
      pingTimerRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 25000);
    };

    ws.onclose = () => {
      if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
      if (wsRef.current !== ws || !shouldReconnectRef.current) return;
      setConnected(false);
      const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
      retryRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    ws.onerror = () => { /* onclose drives the retry */ };
  }, [roomId, token]);

  useEffect(() => {
    connect();
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
      const closing = wsRef.current;
      wsRef.current = null;
      closing?.close();
    };
  }, [connect]);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  // Permanently tear down the socket and stop reconnecting (used when a host
  // kicks us — otherwise the auto-reconnect would silently put us right back).
  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
    const ws = wsRef.current;
    wsRef.current = null;
    ws?.close();
    setConnected(false);
  }, []);

  const sendOp = useCallback((op) => send({ type: "op", op }), [send]);
  const sendCursor = useCallback((x, y, drawing) => send({ type: "cursor", x, y, drawing }), [send]);
  const sendClear = useCallback(() => send({ type: "clear" }), [send]);
  const sendRestore = useCallback(() => send({ type: "undo_clear" }), [send]);
  const sendSheet = useCallback((sheetId) => send({ type: "set_sheet", sheetId }), [send]);
  const sendChat = useCallback((message) => send({ type: "chat", message }), [send]);
  const sendRename = useCallback(
    (name, color) => {
      send({ type: "rename", name, color });
      // Optimistically reflect the change in our own presence.
      setSelf((current) => (current ? { ...current, name: name ?? current.name, color: color ?? current.color } : current));
    },
    [send],
  );

  // Host-only room controls (the server enforces that the sender is a host).
  const sendLock = useCallback(() => send({ type: "lock" }), [send]);
  const sendUnlock = useCallback(() => send({ type: "unlock" }), [send]);
  const sendKick = useCallback((targetId) => send({ type: "kick", targetId }), [send]);
  const sendMute = useCallback((targetId, muted) => send({ type: "mute", targetId, muted }), [send]);
  const sendRenameRoom = useCallback((name) => send({ type: "rename_room", name }), [send]);
  const sendPromote = useCallback((targetId) => send({ type: "promote", targetId }), [send]);
  const sendDemote = useCallback((targetId) => send({ type: "demote", targetId }), [send]);

  // Moderation: report whether we can run the in-browser watcher, flag a region,
  // and (host-only, enforced server-side) reversibly hide / restore / remove ops.
  const sendWatcherAck = useCallback((capable) => send({ type: "watcher_ack", capable }), [send]);
  const sendFlag = useCallback((payload) => send({ type: "flag", ...payload }), [send]);
  const sendModHide = useCallback((opIds) => send({ type: "mod_hide", opIds }), [send]);
  const sendModRestore = useCallback((opIds) => send({ type: "mod_restore", opIds }), [send]);
  const sendModRemove = useCallback((opIds) => send({ type: "mod_remove", opIds }), [send]);

  return {
    connected, users, self, chat, disconnect,
    sendOp, sendCursor, sendClear, sendRestore, sendSheet, sendRename, sendChat,
    sendLock, sendUnlock, sendKick, sendMute, sendRenameRoom, sendPromote, sendDemote,
    sendWatcherAck, sendFlag, sendModHide, sendModRestore, sendModRemove,
  };
}
