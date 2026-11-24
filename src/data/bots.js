// The four Drawesome paint bots. One identity everywhere: the homepage poster,
// room bots and the clean-up game all use these characters, and every surface
// that shows them says they are bots (DESIGN-DIRECTION.md: no invented people).
// Plain ESM with no browser or Node globals, so the server can import it too.
export const BOTS = [
  { id: 'pip', name: 'Pip', tag: '#d93a22', inks: ['#e7472d', '#ff9f1c'] },
  { id: 'fern', name: 'Fern', tag: '#16865a', inks: ['#22b07a', '#a4dd3c'] },
  { id: 'momo', name: 'Momo', tag: '#2a62d6', inks: ['#3d8bf2', '#4fd4e6'] },
  { id: 'zed', name: 'Zed', tag: '#a02fc4', inks: ['#ff5fa2', '#8f5bf0'] },
];
