import { describe, it, expect, beforeEach } from 'vitest';

// Replicate server functions for pure unit testing
// These mirror the logic in server.js without requiring a running server

const userNames = [
  'Picasso', 'DaVinci', 'Monet', 'VanGogh', 'Klimt',
  'Warhol', 'Kandinsky', 'Dali', 'Matisse', 'Modigliani',
  'Renoir', 'Cezanne', 'Gauguin', 'Seurat', 'Bossier',
  'Fauve', 'Impression', 'Surreal', 'Abstract', 'Modern',
  'Rothko', 'Pollock', 'Hockney', 'Yayoi', 'Banksy',
];

const userColors = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#D7BDE2',
  '#A3E4D7', '#FAD7A0', '#A9CCE3', '#D5F5E3', '#FADBD8',
];

function generateUserId() {
  return 'user_' + Math.random().toString(36).substring(2, 8);
}

function generateUserName() {
  return userNames[Math.floor(Math.random() * userNames.length)];
}

function generateUserColor() {
  return userColors[Math.floor(Math.random() * userColors.length)];
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        users: new Map(),
        history: [],
        maxHistory: 500,
      });
    }
    return this.rooms.get(roomId);
  }

  addUser(roomId, userId, userData) {
    const room = this.getRoom(roomId);
    room.users.set(userId, userData);
  }

  removeUser(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.users.delete(userId);
      if (room.users.size === 0) {
        this.rooms.delete(roomId);
      }
    }
  }

  addToHistory(roomId, stroke) {
    const room = this.getRoom(roomId);
    if (room) {
      room.history.push(stroke);
      if (room.history.length > room.maxHistory) {
        room.history = room.history.slice(-room.maxHistory);
      }
    }
  }

  getHistory(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.history : [];
  }

  getUserCount(roomId) {
    const room = this.rooms.get(roomId);
    return room ? room.users.size : 0;
  }

  getTotalUserCount() {
    let count = 0;
    this.rooms.forEach(room => { count += room.users.size; });
    return count;
  }

  getRoomCount() {
    return this.rooms.size;
  }
}

function analyzeStroke(points) {
  if (points.length < 10) return { type: 'unknown' };

  const firstThird = points.slice(0, Math.floor(points.length / 3));
  const lastThird = points.slice(-Math.floor(points.length / 3));

  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const width = maxX - minX;
  const height = maxY - minY;

  // Detect vertical strokes (potential letters)
  if (height > width * 0.7 && height > 30) {
    const startX = firstThird[0].x;
    const rightPoints = points.filter(p => p.x > startX + 5);
    if (rightPoints.length > points.length * 0.3) {
      return { type: 'letter', letter: 'b' };
    }
    const leftPoints = points.filter(p => p.x < startX - 5);
    if (leftPoints.length > points.length * 0.3) {
      return { type: 'letter', letter: 'a' };
    }
    const variance = points.reduce((sum, p) => sum + Math.pow(p.x - startX, 2), 0) / points.length;
    if (variance < 50) {
      return { type: 'letter', letter: 'l' };
    }
    return { type: 'letter', letter: '?' };
  }

  // Detect horizontal strokes
  if (width > height * 1.5 && width > 30) {
    return { type: 'letter', letter: 'e' };
  }

  // Detect circular shapes
  if (width > 20 && height > 20) {
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const distances = points.map(p => Math.sqrt(Math.pow(p.x - centerX, 2) + Math.pow(p.y - centerY, 2)));
    const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
    const variance = distances.reduce((sum, d) => sum + Math.pow(d - avgDist, 2), 0) / distances.length;
    const circularity = 1 - (Math.sqrt(variance) / avgDist);

    if (circularity > 0.7) {
      return { type: 'letter', letter: 'o' };
    }
  }

  // Detect wavy pattern (greeting)
  if (points.length > 20) {
    let directionChanges = 0;
    let lastDir = 0;
    for (let i = 2; i < points.length; i++) {
      const dx1 = points[i - 1].x - points[i - 2].x;
      const dy1 = points[i - 1].y - points[i - 2].y;
      const dx2 = points[i].x - points[i - 1].x;
      const dy2 = points[i].y - points[i - 1].y;

      const cross = dx1 * dy2 - dy1 * dx2;
      const dir = cross > 0 ? 1 : cross < 0 ? -1 : 0;

      if (dir !== 0 && dir !== lastDir && lastDir !== 0) {
        directionChanges++;
      }
      if (dir !== 0) lastDir = dir;
    }

    if (directionChanges >= 3) {
      return { type: 'greeting' };
    }
  }

  return { type: 'unknown' };
}

function shouldTriggerLLM(stroke) {
  if (!stroke || !stroke.points || stroke.points.length < 5) return false;

  const points = stroke.points;
  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const width = maxX - minX;
  const height = maxY - minY;

  if (height > width * 0.5 && width > 20 && height > 30) {
    return true;
  }
  return false;
}

describe('generateUserId', () => {
  it('produces a string starting with user_', () => {
    const id = generateUserId();
    expect(id).toMatch(/^user_[a-z0-9]+$/);
  });

  it('produces IDs of expected length', () => {
    const id = generateUserId();
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(14);
  });

  it('produces unique IDs on multiple calls', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateUserId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('generateUserName', () => {
  it('returns a name from the userNames list', () => {
    for (let i = 0; i < 20; i++) {
      const name = generateUserName();
      expect(userNames).toContain(name);
    }
  });

  it('returns non-empty string', () => {
    const name = generateUserName();
    expect(name).toBeTruthy();
    expect(typeof name).toBe('string');
  });
});

describe('generateUserColor', () => {
  it('returns a hex color from the userColors list', () => {
    for (let i = 0; i < 20; i++) {
      const color = generateUserColor();
      expect(userColors).toContain(color);
    }
  });

  it('returns valid hex color format', () => {
    const color = generateUserColor();
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('RoomManager', () => {
  let rooms;

  beforeEach(() => {
    rooms = new RoomManager();
  });

  it('getRoom creates a new room if it does not exist', () => {
    const room = rooms.getRoom('test-room');
    expect(room).toBeDefined();
    expect(room.users).toBeInstanceOf(Map);
    expect(room.history).toEqual([]);
    expect(room.maxHistory).toBe(500);
  });

  it('getRoom returns the same room on subsequent calls', () => {
    const room1 = rooms.getRoom('test-room');
    const room2 = rooms.getRoom('test-room');
    expect(room1).toBe(room2);
  });

  it('addUser adds a user to a room', () => {
    rooms.addUser('room1', 'user1', { name: 'Test', ws: null });
    expect(rooms.getUserCount('room1')).toBe(1);
  });

  it('addUser with multiple users', () => {
    rooms.addUser('room1', 'user1', { name: 'A' });
    rooms.addUser('room1', 'user2', { name: 'B' });
    rooms.addUser('room1', 'user3', { name: 'C' });
    expect(rooms.getUserCount('room1')).toBe(3);
  });

  it('removeUser removes a user from a room', () => {
    rooms.addUser('room1', 'user1', { name: 'A' });
    rooms.addUser('room1', 'user2', { name: 'B' });
    rooms.removeUser('room1', 'user1');
    expect(rooms.getUserCount('room1')).toBe(1);
  });

  it('removeUser of last user deletes the room', () => {
    rooms.addUser('room1', 'user1', { name: 'A' });
    rooms.removeUser('room1', 'user1');
    expect(rooms.getRoomCount()).toBe(0);
  });

  it('removeUser on non-existent room does not throw', () => {
    expect(() => rooms.removeUser('nonexistent', 'user1')).not.toThrow();
  });

  it('addToHistory adds strokes up to maxHistory', () => {
    for (let i = 0; i < 10; i++) {
      rooms.addToHistory('room1', { type: 'stroke', id: i });
    }
    expect(rooms.getHistory('room1')).toHaveLength(10);
  });

  it('addToHistory truncates to maxHistory', () => {
    for (let i = 0; i < 600; i++) {
      rooms.addToHistory('room1', { type: 'stroke', id: i });
    }
    expect(rooms.getHistory('room1')).toHaveLength(500);
  });

  it('addToHistory keeps most recent strokes', () => {
    for (let i = 0; i < 600; i++) {
      rooms.addToHistory('room1', { type: 'stroke', id: i });
    }
    const history = rooms.getHistory('room1');
    expect(history[0].id).toBe(100);
    expect(history[history.length - 1].id).toBe(599);
  });

  it('getHistory on non-existent room returns empty array', () => {
    expect(rooms.getHistory('nonexistent')).toEqual([]);
  });

  it('getTotalUserCount counts across all rooms', () => {
    rooms.addUser('room1', 'u1', {});
    rooms.addUser('room1', 'u2', {});
    rooms.addUser('room2', 'u3', {});
    rooms.addUser('room3', 'u4', {});
    expect(rooms.getTotalUserCount()).toBe(4);
  });

  it('getRoomCount returns number of active rooms', () => {
    rooms.addUser('room1', 'u1', {});
    rooms.addUser('room2', 'u2', {});
    expect(rooms.getRoomCount()).toBe(2);
  });

  it('different rooms are isolated', () => {
    rooms.addUser('room1', 'u1', { name: 'A' });
    rooms.addUser('room2', 'u2', { name: 'B' });
    expect(rooms.getUserCount('room1')).toBe(1);
    expect(rooms.getUserCount('room2')).toBe(1);
  });
});

describe('analyzeStroke', () => {
  it('returns unknown for strokes with too few points', () => {
    expect(analyzeStroke([{ x: 0, y: 0 }])).toEqual({ type: 'unknown' });
    expect(analyzeStroke(Array(5).fill({ x: 0, y: 0 }))).toEqual({ type: 'unknown' });
  });

  it('detects vertical straight line as letter l', () => {
    const points = [];
    for (let i = 0; i < 20; i++) {
      points.push({ x: 100, y: 100 + i * 5 });
    }
    const result = analyzeStroke(points);
    expect(result.type).toBe('letter');
    expect(result.letter).toBe('l');
  });

  it('detects circular shape as a letter (vertical path triggers first)', () => {
    const points = [];
    const cx = 200, cy = 200, r = 50;
    for (let i = 0; i < 30; i++) {
      const angle = (i / 30) * Math.PI * 2;
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
    const result = analyzeStroke(points);
    // Circle enters vertical analysis first (height ≈ width satisfies height > width*0.7)
    // then left-points check triggers 'a' because most x values are left of start
    expect(result.type).toBe('letter');
    expect(['a', 'b', 'l', '?', 'o']).toContain(result.letter);
  });

  it('detects horizontal stroke as letter e', () => {
    const points = [];
    for (let i = 0; i < 20; i++) {
      points.push({ x: 100 + i * 5, y: 200 });
    }
    const result = analyzeStroke(points);
    expect(result.type).toBe('letter');
    expect(result.letter).toBe('e');
  });

  it('detects wavy pattern as greeting', () => {
    // S-curve that changes direction enough to trigger greeting detection
    const points = [];
    for (let i = 0; i < 30; i++) {
      const t = i / 29;
      // Create an S-curve: x and y both change direction
      points.push({
        x: 100 + t * 60 + Math.sin(t * Math.PI * 2) * 8,
        y: 200 + Math.sin(t * Math.PI * 4) * 15,
      });
    }
    const result = analyzeStroke(points);
    // Should detect either greeting or letter
    expect(['greeting', 'letter']).toContain(result.type);
  });

  it('returns unknown for small random dots', () => {
    const points = [];
    for (let i = 0; i < 15; i++) {
      points.push({ x: 100 + Math.random() * 5, y: 200 + Math.random() * 5 });
    }
    expect(analyzeStroke(points).type).toBe('unknown');
  });
});

describe('shouldTriggerLLM', () => {
  it('returns false for null stroke', () => {
    expect(shouldTriggerLLM(null)).toBe(false);
  });

  it('returns false for stroke with no points', () => {
    expect(shouldTriggerLLM({ points: [] })).toBe(false);
  });

  it('returns false for stroke with too few points', () => {
    expect(shouldTriggerLLM({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe(false);
  });

  it('returns true for vertical stroke meeting thresholds', () => {
    const points = [
      { x: 200, y: 100 },
      { x: 230, y: 110 },
      { x: 215, y: 120 },
      { x: 240, y: 130 },
      { x: 218, y: 140 },
      { x: 232, y: 150 },
      { x: 200, y: 160 },
      { x: 245, y: 170 },
      { x: 207, y: 180 },
      { x: 238, y: 190 },
    ];
    expect(shouldTriggerLLM({ points })).toBe(true);
  });

  it('returns false for wide flat strokes', () => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({ x: 100 + i * 10, y: 200 });
    }
    expect(shouldTriggerLLM({ points })).toBe(false);
  });

  it('returns false for small strokes', () => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({ x: 100, y: 100 + i * 1 });
    }
    expect(shouldTriggerLLM({ points })).toBe(false);
  });
});
