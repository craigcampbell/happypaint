# Mural Jam

A collaborative mural studio built with React, Vite, Canvas, WebGL, and WebSockets. Artists can join the same mural room, paint together in real time, leave, and return to the saved mural history.

## Features

- Shared mural rooms with stable invite URLs
- Disk-backed mural stroke history on the server
- PNG export for saving a mural snapshot
- Multiple tactile brushes, including watercolor, oil, sponge, smudge, and palette knife
- Canvas/WebGL rendering with 3D stroke effects
- Mobile-friendly bottom tool tray

## Getting Started

```bash
npm install
npm run dev
```

Murals are stored in `.murals/murals.json` while the server runs. Set `MAX_ROOM_USERS` to change the per-mural artist capacity.
