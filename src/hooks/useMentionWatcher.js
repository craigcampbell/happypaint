import { useEffect, useRef } from "react";

// Opens ONE lightweight "notify" WebSocket that watches other rooms' chat for
// @mentions of the given display name and calls onMention({room,roomTitle,from,
// text,ts}) for each. It carries no canvas traffic, so watching several rooms is
// cheap. The socket is separate from the studio's room socket.
//
// It re-asserts its watch periodically so a watched room that (re)opens on the
// server gets picked up, and pings to stay alive through the tunnel.

function notifySocketUrl() {
  const override = import.meta.env.VITE_WS_URL;
  if (override) return `${override}?notify=1`;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  let host = window.location.host;
  if (host.endsWith(":5173")) host = host.replace(":5173", ":8787");
  return `${proto}://${host}/ws?notify=1`;
}

export function useMentionWatcher(rooms, name, onMention) {
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;
  const nameRef = useRef(name);
  nameRef.current = name;

  // Stable primitive dep so we only reconnect when the actual set/name changes.
  const roomsKey = Array.isArray(rooms) ? rooms.filter(Boolean).join(",") : "";

  useEffect(() => {
    if (!name || !roomsKey) return undefined; // nothing to watch yet
    const roomList = roomsKey.split(",").filter(Boolean);
    let closed = false;
    let ws = null;
    let reconnectTimer = null;
    let rewatchTimer = null;
    let pingTimer = null;

    const sendWatch = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "watch", rooms: roomList, name: nameRef.current }));
      }
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(notifySocketUrl());
      } catch {
        reconnectTimer = window.setTimeout(connect, 3000);
        return;
      }
      ws.onopen = () => {
        sendWatch();
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 25000);
      };
      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "mention") onMentionRef.current?.(data);
      };
      ws.onclose = () => {
        if (pingTimer) window.clearInterval(pingTimer);
        // Jitter so a server restart doesn't make every tab reconnect in lockstep.
        if (!closed) reconnectTimer = window.setTimeout(connect, 3000 + Math.random() * 3000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // onclose drives the retry
        }
      };
    };

    connect();
    // Re-assert the watch so rooms that (re)open on the server get us attached.
    rewatchTimer = window.setInterval(sendWatch, 60000);

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (rewatchTimer) window.clearInterval(rewatchTimer);
      if (pingTimer) window.clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [roomsKey, name]);
}
