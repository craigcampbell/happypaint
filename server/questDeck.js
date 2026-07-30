const MISSIONS = [
  { id: 'tiny-frog', emoji: '🐸', text: 'Hide a tiny frog somewhere in the picture.' },
  { id: 'finish-a-friend', emoji: '🤝', text: 'Add something another artist can finish.' },
  { id: 'happy-accident', emoji: '✨', text: 'Turn an accidental mark into a character.' },
  { id: 'three-colors', emoji: '🎨', text: 'Make one corner using only three colors.' },
  { id: 'shared-creature', emoji: '🐲', text: 'Everyone adds one part to the same creature.' },
  { id: 'secret-door', emoji: '🚪', text: 'Add a secret door and show what is behind it.' },
  { id: 'tiny-world', emoji: '🔍', text: 'Draw a tiny world hiding inside a bigger object.' },
  { id: 'weather-switch', emoji: '🌦️', text: 'Change the weather in part of the picture.' },
  { id: 'silly-hat', emoji: '🎩', text: 'Give something a hat that makes no sense.' },
  { id: 'friendly-shadow', emoji: '👤', text: 'Turn a shadow into a friendly surprise.' },
  { id: 'pattern-pass', emoji: '🌀', text: 'Start a pattern and let a friend continue it.' },
  { id: 'color-trail', emoji: '🌈', text: 'Make a color trail that connects two drawings.' },
];

export function questMissions(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  return MISSIONS.filter((mission) => wanted.has(mission.id));
}

export function questSetFor(roomId, date = new Date()) {
  const day = Math.floor(date.getTime() / 86_400_000);
  let seed = day;
  for (const char of String(roomId || 'QUEST')) seed = (seed * 33 + char.charCodeAt(0)) >>> 0;
  const picks = [];
  let cursor = seed % MISSIONS.length;
  while (picks.length < 3) {
    const mission = MISSIONS[cursor % MISSIONS.length];
    if (!picks.some((item) => item.id === mission.id)) picks.push(mission);
    cursor = (cursor + 5) % MISSIONS.length;
  }
  return {
    setId: `${day.toString(36)}-${String(roomId || 'QUEST').slice(0, 8)}`,
    missions: picks,
  };
}
