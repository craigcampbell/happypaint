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
  // Vite dev can run on a few local ports; the websocket lives on the node
  // server (8787). VITE_WS_URL remains the escape hatch for custom setups.
  if (import.meta.env.DEV) {
    const pageUrl = new URL(window.location.href);
    if (pageUrl.port && pageUrl.port !== "8787") {
      host = `${pageUrl.hostname}:8787`;
    }
  }
  return `${proto}://${host}/ws?room=${encodeURIComponent(roomId)}${tokenQs}`;
}

function clientInfoPayload() {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const nav = window.navigator || {};
    let pointer = "none";
    if (window.matchMedia?.("(pointer: coarse)").matches) pointer = "coarse";
    else if (window.matchMedia?.("(pointer: fine)").matches) pointer = "fine";
    return {
      type: "client_info",
      timezone: resolved.timeZone || null,
      locale: nav.language || resolved.locale || null,
      viewportW: window.innerWidth || null,
      viewportH: window.innerHeight || null,
      pointer,
    };
  } catch {
    return { type: "client_info" };
  }
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
      ws.send(JSON.stringify(clientInfoPayload()));
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
  // In an animation room `frameId` scopes the clear to one shared frame;
  // omitted (legacy rooms) it wipes the whole mural.
  const sendClear = useCallback((frameId) => send(frameId ? { type: "clear", frameId } : { type: "clear" }), [send]);
  const sendRestore = useCallback(() => send({ type: "undo_clear" }), [send]);
  const sendSheet = useCallback((sheetId) => send({ type: "set_sheet", sheetId }), [send]);
  // Trace-a-photo: upload a user photo as the room's traced underlay. The image
  // rides the WS once (host/private-gated + validated server-side); everyone
  // then loads it through the normal sheet path.
  const sendTracePhoto = useCallback((image) => send({ type: "set_trace_photo", image }), [send]);
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

  // Wet-canvas toggle + theme voting (permissions enforced server-side:
  // host-only in public rooms, any member in private rooms).
  const sendSetWet = useCallback((wet) => send({ type: "set_wet", wet }), [send]);
  // Shared animation: private-room hosts flip the film strip on/off; frame
  // structure mutations are relayed and the server echoes them to EVERYONE
  // (including the sender) so all clients apply them in server order.
  const sendSetAnimation = useCallback((enabled) => send({ type: "set_animation", enabled }), [send]);
  const sendFrameAdd = useCallback(
    (afterFrameId, duplicateOf, sceneId) =>
      send({ type: "frame_add", afterFrameId: afterFrameId || null, duplicateOf: duplicateOf || null, sceneId: sceneId || null }),
    [send],
  );
  const sendFrameDel = useCallback((frameId) => send({ type: "frame_del", frameId }), [send]);
  const sendFrameMove = useCallback((frameId, toIndex) => send({ type: "frame_move", frameId, toIndex }), [send]);
  const sendFrameDuration = useCallback((frameId, durationMs) => send({ type: "frame_duration", frameId, durationMs }), [send]);
  // Scenes: page one scene's frames+ops in (memory stays at a scene's worth);
  // scene creation/deletion is host-only (enforced server-side).
  const sendSceneFetch = useCallback((sceneId) => send({ type: "scene_fetch", sceneId }), [send]);
  const sendSceneAdd = useCallback(() => send({ type: "scene_add" }), [send]);
  const sendSceneDel = useCallback((sceneId) => send({ type: "scene_del", sceneId }), [send]);
  // Productions: tie segment rooms into one film (host-only, server-enforced).
  const sendProductionCreate = useCallback((title) => send({ type: "production_create", title: title || null }), [send]);
  const sendProductionAddSegment = useCallback(() => send({ type: "production_add_segment" }), [send]);
  const sendProductionRename = useCallback((title) => send({ type: "production_rename", title }), [send]);
  // Crew presence (COLD path — sent on frame-select / scene-switch / join, never
  // per stroke) + the "come look at my frame!" beacon. Both ephemeral, relayed.
  const sendFramePresence = useCallback((sceneId, frameId) => send({ type: "frame_presence", sceneId: sceneId || null, frameId: frameId || null }), [send]);
  const sendBeacon = useCallback((sceneId, frameId) => send({ type: "beacon", sceneId: sceneId || null, frameId: frameId || null }), [send]);
  // Confetti cheer on a frame (curated emoji, ephemeral).
  const sendCheer = useCallback((frameId, emoji) => send({ type: "cheer", frameId: frameId || null, emoji }), [send]);
  // Ephemeral emoji reaction dropped at a world point (never persisted).
  const sendReaction = useCallback((emoji, x, y) => send({ type: "reaction", emoji, x, y }), [send]);
  const sendVoteStart = useCallback(() => send({ type: "vote_start" }), [send]);
  const sendVote = useCallback((choice) => send({ type: "vote", choice }), [send]);
  // Creative room capabilities. The server owns/persists canonical room state;
  // clients send only bounded ids/values.
  const sendSetSymmetry = useCallback((mode) => send({ type: "set_symmetry", mode }), [send]);
  const sendQuestNominate = useCallback((missionId) => send({ type: "quest_nominate", missionId }), [send]);
  const sendQuestReset = useCallback(() => send({ type: "quest_reset" }), [send]);
  const sendStorybookCaption = useCallback(
    (sceneId, caption) => send({ type: "storybook_caption", sceneId, caption }),
    [send],
  );
  const sendStorybookLock = useCallback(
    (sceneId, locked) => send({ type: "storybook_lock", sceneId, locked }),
    [send],
  );
  const sendStorybookMove = useCallback(
    (sceneId, toIndex) => send({ type: "storybook_move", sceneId, toIndex }),
    [send],
  );
  // Draw & Guess: guesses ride normal sendChat (server checks them). These
  // control the round: the drawer/host can skip, a private-room host toggles the
  // game on/off. Incoming game_* messages auto-forward to the App dispatcher.
  const sendGameSkip = useCallback(() => send({ type: "game_skip" }), [send]);
  const sendSetGame = useCallback((enabled) => send({ type: "set_game", enabled }), [send]);
  // Draw Phone (telephone): a private-room host toggles it / starts a game; each
  // player submits their page (a drawn PNG or a text guess) per round; the host
  // can force-advance. Incoming phone_* messages auto-forward to the dispatcher.
  const sendSetPhone = useCallback((enabled) => send({ type: "set_phone", enabled }), [send]);
  const sendPhoneStart = useCallback(() => send({ type: "phone_start" }), [send]);
  const sendPhoneSubmit = useCallback((payload) => send({ type: "phone_submit", ...payload }), [send]);
  const sendPhoneSkip = useCallback(() => send({ type: "phone_skip" }), [send]);

  // Moderation: report whether we can run the in-browser watcher, flag a region,
  // and (host-only, enforced server-side) reversibly hide / restore / remove ops.
  const sendWatcherAck = useCallback((capable) => send({ type: "watcher_ack", capable }), [send]);
  const sendFlag = useCallback((payload) => send({ type: "flag", ...payload }), [send]);
  const sendModHide = useCallback((opIds) => send({ type: "mod_hide", opIds }), [send]);
  const sendModRestore = useCallback((opIds) => send({ type: "mod_restore", opIds }), [send]);
  const sendModRemove = useCallback((opIds) => send({ type: "mod_remove", opIds }), [send]);

  return {
    connected, users, self, chat, disconnect,
    sendOp, sendCursor, sendClear, sendRestore, sendSheet, sendTracePhoto, sendRename, sendChat,
    sendLock, sendUnlock, sendKick, sendMute, sendRenameRoom, sendPromote, sendDemote,
    sendSetWet, sendVoteStart, sendVote, sendReaction, sendSetSymmetry,
    sendQuestNominate, sendQuestReset, sendStorybookCaption, sendStorybookLock, sendStorybookMove,
    sendGameSkip, sendSetGame,
    sendSetPhone, sendPhoneStart, sendPhoneSubmit, sendPhoneSkip,
    sendSetAnimation, sendFrameAdd, sendFrameDel, sendFrameMove, sendFrameDuration,
    sendSceneFetch, sendSceneAdd, sendSceneDel,
    sendProductionCreate, sendProductionAddSegment, sendProductionRename,
    sendFramePresence, sendBeacon, sendCheer,
    sendWatcherAck, sendFlag, sendModHide, sendModRestore, sendModRemove,
  };
}
