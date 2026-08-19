import { useEffect, useRef } from "react";

// Opens ONE lightweight "notify" WebSocket that watches other rooms' chat for
// @mentions of you and calls onMention({room,roomTitle,from,ts}) for each. It
// carries no canvas traffic, so watching several rooms is cheap. The socket is
// separate from the studio's room socket.
//
// `watchList` entries are { code, name, key }: the room, the display name we
// held there, and the mentionKey capability its join handshake issued. The
// server refuses watches without a valid key, so this channel can't be used to
// probe rooms or impersonate names.
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

export function useMentionWatcher(watchList, onMention) {
  const onMentionRef = useRef(onMention);
  onMentionRef.current = onMention;
  const watchRef = useRef(watchList);
  watchRef.current = watchList;

  // Stable primitive dep so we only reconnect when the actual set changes.
  const watchKey = Array.isArray(watchList)
    ? watchList
        .filter((w) => w && w.code && w.name && w.key)
        .map((w) => `${w.code}:${w.key}`)
        .join(",")
    : "";

  useEffect(() => {
    if (!watchKey) return undefined; // nothing watchable yet
    let closed = false;
    let ws = null;
    let reconnectTimer = null;
    let rewatchTimer = null;
    let pingTimer = null;

    const sendWatch = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const rooms = (watchRef.current || [])
          .filter((w) => w && w.code && w.name && w.key)
          .map((w) => ({ code: w.code, name: w.name, key: w.key }));
        ws.send(JSON.stringify({ type: "watch", rooms }));
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
  }, [watchKey]);
}
