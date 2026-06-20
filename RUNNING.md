# Drawesome 🎨 — running & hosting guide

This is the live setup behind **https://drawesome.art** — a real-time, paint-together
studio. Everyone who opens the site draws on the same shared canvas, with live
cursors and chat.

## TL;DR — how the kids play

1. Make sure **the server is running** on this PC (see below) and the PC is awake.
2. Friends go to **https://drawesome.art** and tap **“Paint in Browser”**
   (or open **https://drawesome.art/studio** directly).
3. Everyone lands in the same room (`MAIN`) and draws together.
4. Want a private group? Use a room code: **https://drawesome.art/join/ELSA**
   (any word/code) — everyone who opens the same `/join/<CODE>` link shares that
   canvas. The **“Invite a friend”** button in the studio copies a join link.

## Architecture (no Docker, no database)

The backend is a **single Node.js process** — `server.js`. There is **no Docker
and no Supabase**; the optional auth/sync layer in this branch is switched off
(its env vars are unset), so the app runs fully local.

```
Browser ──HTTPS/WSS──▶ Cloudflare ──▶ cloudflared tunnel ──▶ localhost:8787 (server.js)
                                                              ├─ serves the built app (dist/)
                                                              └─ WebSocket relay at /ws
```

- `server.js` serves the built front-end **and** the WebSocket that relays drawing
  strokes / cursors / chat between everyone in a room.
- The shared canvas for each room lives **in memory** in that process. If the
  server restarts, in-progress shared canvases reset (each kid’s *own* art also
  autosaves locally in their browser).
- Port: **8787** (`PORT` env var to change it).

## Start / restart the server

The server is **not** set to auto-start. After a reboot (or if it stops), start it
manually:

```powershell
cd "C:\Users\Craig Campbell\Projects\happypaint"
node server.js
```

That window must stay open while the kids play. To run it in the background
(survives closing the terminal), use:

```powershell
cd "C:\Users\Craig Campbell\Projects\happypaint"
Start-Process node -ArgumentList "server.js" -WorkingDirectory (Get-Location) -WindowStyle Hidden `
  -RedirectStandardOutput "server.out.log" -RedirectStandardError "server.err.log"
```

Check it’s up:

```powershell
curl http://localhost:8787/healthz      # -> {"ok":true,...}
```

Stop a background instance:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## After changing code

The server serves files from `dist/`, so rebuild after any front-end change:

```powershell
npm run build      # rebuilds dist/ (served immediately, no server restart needed)
```

If you change `server.js` itself, restart the server (stop + start above).

## Hosting (Cloudflare tunnel)

- The domain `drawesome.art` is on **Cloudflare DNS** (nameservers `chelsea` /
  `woz`.ns.cloudflare.com).
- A **Cloudflare Tunnel** named `drawesome.art` (runs as the `cloudflared` Windows
  **service** on this PC) carries traffic to `localhost:8787`.
- The route is configured in the Cloudflare **Zero Trust** dashboard →
  **Networks → Connectors → drawesome.art → Published application routes**:
  `drawesome.art` (path `*`) → `http://localhost:8787`.
- Cloudflare provides HTTPS automatically and proxies WebSockets — no extra config.

So the only moving part you manage is **keeping `node server.js` running** on this PC.

## Troubleshooting

- **Site won’t load for the kids:** confirm the server is up
  (`curl http://localhost:8787/healthz`) and this PC is awake & online.
- **Works elsewhere but not on this PC:** this PC was pointed at Cloudflare DNS
  (`1.1.1.1`) because the router cached the old record. Revert anytime (admin
  PowerShell): `Set-DnsClientServerAddress -InterfaceIndex 8 -ResetServerAddresses`.
- **“Connecting…” in the studio:** the WebSocket didn’t connect — almost always the
  server isn’t running. Start it.

## iOS app (later)

To make a native iOS app join the same canvases, connect to:

```
wss://drawesome.art/ws?room=MAIN
```

and speak the same small JSON protocol the web client uses:

- Send a stroke (incrementally, as points are drawn):
  `{"type":"op","op":{"kind":"draw","strokeId":"<unique>","settings":{"brush":"marker","color":"#ff0000","size":12,"opacity":1,"variation":0},"points":[{"x":10,"y":10},{"x":40,"y":40}]}}`
  Coordinates are in the shared 3840×2400 canvas space (see `CANVAS_WIDTH`/`CANVAS_HEIGHT` in `src/utils/layers.js`).
- Other ops: `{"kind":"shape",...}`, `{"kind":"text",...}`; plus top-level
  `{"type":"cursor","x":0..1,"y":0..1,"drawing":true}`, `{"type":"clear"}`,
  `{"type":"chat","message":"hi"}`, `{"type":"ping"}`.
- On connect the server sends `connected`, `userList`, then `history` (replay of the
  room so far). It relays others’ `op` / `cursor` / `chat` to you.

See `server.js` for the full message set and `src/hooks/useMultiplayer.js` +
`src/App.jsx` for the reference client.

## Saved drawings ("My Art")

Tapping **💾 Save** stores the artwork on the server so kids can come back and
keep drawing (the **📁 My Art** button reopens them).

- Files live in **`.artworks/`** (one JSON per device key). This folder is
  git-ignored — **back it up** if you want to keep saved art across machines.
- Each device gets an anonymous key (browser localStorage). Saves are capped at
  **12 per device** (`MAX_SAVES` env var). This is the storage a future sign-in
  will adopt — swap the device key for an authenticated user id.
- The service worker (`public/sw.js`) is network-first for the app shell and
  **never** caches `/api/*` — bump `CACHE_NAME` if you change it.
