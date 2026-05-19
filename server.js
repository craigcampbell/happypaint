import express from 'express';
import { WebSocketServer, WebSocketServer as WSS, createWebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

const app = express();
const server = createServer(app);
const wss = new WSS({ server });

const PORT = process.env.PORT || 3001;
const VITE_PORT = 5173;

// Initialize OpenAI if API key is set
let openai = null;
const apiKey = process.env.OPENAI_API_KEY || '';
if (apiKey && apiKey !== 'your-openai-api-key-here') {
  openai = new OpenAI({ apiKey });
  console.log('OpenAI API configured');
}

// Room management
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      history: [],
      maxHistory: 500,
    });
  }
  return rooms.get(roomId);
}

function generateUserId() {
  return 'user_' + Math.random().toString(36).substring(2, 8);
}

const userNames = [
  'Picasso', 'DaVinci', 'Monet', 'VanGogh', 'Klimt',
  'Warhol', 'Kandinsky', 'Dali', 'Matisse', 'Modigliani',
  'Renoir', 'Cezanne', 'Gauguin', 'Seurat', 'Bossier',
  'Fauve', 'Impression', 'Surreal', 'Abstract', 'Modern',
  'Rothko', 'Pollock', 'Hockney', 'Yayoi', 'Banksy',
];

function generateUserName() {
  return userNames[Math.floor(Math.random() * userNames.length)];
}

const userColors = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#D7BDE2',
  '#A3E4D7', '#FAD7A0', '#A9CCE3', '#D5F5E3', '#FADBD8',
];

function generateUserColor() {
  return userColors[Math.floor(Math.random() * userColors.length)];
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'main';
  const room = getRoom(roomId);

  const userId = generateUserId();
  const userName = generateUserName();
  const userColor = generateUserColor();

  const user = {
    id: userId,
    name: userName,
    color: userColor,
    ws,
  };

  room.users.set(userId, user);
  ws.roomId = roomId;
  ws.userId = userId;

  // Send user their own info
  ws.send(JSON.stringify({
    type: 'connected',
    userId,
    userName,
    userColor,
    roomId,
  }));

  // Send room user list
  const userList = Array.from(room.users.values()).map(u => ({
    id: u.id,
    name: u.name,
    color: u.color,
  }));
  ws.send(JSON.stringify({
    type: 'userList',
    users: userList,
  }));

  // Broadcast user joined
  broadcastToRoom(roomId, {
    type: 'userJoined',
    user: { id: userId, name: userName, color: userColor },
    userList,
  }, userId);

  // Send canvas history to new user
  if (room.history.length > 0) {
    ws.send(JSON.stringify({
      type: 'history',
      history: room.history.slice(-100),
    }));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'chat':
          // Broadcast chat message
          broadcastToRoom(roomId, {
            type: 'chat',
            user: { id: userId, name: userName, color: userColor },
            message: data.message,
            timestamp: Date.now(),
          }, userId);
          break;

        case 'chat_thread_msg':
          broadcastToRoom(roomId, {
            type: 'chat_thread_msg',
            threadId: data.threadId,
            message: data.message,
          }, userId);
          break;

        case 'chat_thread_create':
          broadcastToRoom(roomId, {
            type: 'chat_thread_create',
            thread: data.thread,
          }, userId);
          break;

        case 'stroke':
          // Broadcast stroke to all other users in room
          broadcastToRoom(roomId, {
            type: 'stroke',
            user: { id: userId, name: userName, color: userColor },
            stroke: data.stroke,
            timestamp: Date.now(),
          }, userId);

          // Store stroke in history
          room.history.push({
            type: 'stroke',
            user: { id: userId, name: userName, color: userColor },
            stroke: data.stroke,
            timestamp: Date.now(),
          });

          if (room.history.length > room.maxHistory) {
            room.history = room.history.slice(-room.maxHistory);
          }

          // Check if LLM should respond
          if (openai && shouldTriggerLLM(data.stroke)) {
            triggerLLMResponse(room, data.stroke, userId);
          }
          break;

        case 'clear':
          broadcastToRoom(roomId, {
            type: 'clear',
            user: { id: userId, name: userName },
            timestamp: Date.now(),
          }, userId);
          room.history = [];
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        case 'chat_with_ai':
          if (openai) {
            handleAIChat(room, data.message, userId);
          }
          break;
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    room.users.delete(userId);
    broadcastToRoom(roomId, {
      type: 'userLeft',
      userId,
      userName,
      userList: Array.from(room.users.values()).map(u => ({
        id: u.id,
        name: u.name,
        color: u.color,
      })),
    });
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for user ${userId}:`, err.message);
  });
});

function broadcastToRoom(roomId, message, excludeUserId = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  room.users.forEach((user) => {
    if (user.id !== excludeUserId && user.ws.readyState === 1) {
      user.ws.send(data);
    }
  });
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

  // Detect potential letter-like shapes (vertical strokes with curves)
  if (height > width * 0.5 && width > 20 && height > 30) {
    return true;
  }

  // Detect color changes (user painting something new)
  return false;
}

async function triggerLLMResponse(room, stroke, userId) {
  const points = stroke.points;
  if (!points || points.length < 5) return;

  // Analyze the stroke to understand what was painted
  const analysis = analyzeStroke(points);

  if (analysis.type === 'letter' && analysis.letter) {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `You are a friendly art assistant in a collaborative painting app called Happy Paint. Users paint letters and shapes on a shared canvas. When you detect a letter was painted, respond with a fun, brief fact about that letter, a word that starts with it, or a creative prompt related to it. Keep responses under 50 words. Be enthusiastic and encouraging.`,
          },
          {
            role: 'user',
            content: `A user just painted the letter "${analysis.letter.toUpperCase()}" on the canvas. Respond with something fun and creative related to this letter.`,
          },
        ],
        max_tokens: 100,
        temperature: 0.8,
      });

      const aiMessage = response.choices[0]?.message?.content || 'Nice painting!';

      broadcastToRoom(roomId, {
        type: 'ai_response',
        message: aiMessage,
        relatedTo: analysis.letter,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('LLM error:', err.message);
    }
  } else if (analysis.type === 'greeting') {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `You are a friendly art assistant in a collaborative painting app called Happy Paint. Users can paint shapes to communicate with you. Be warm, creative, and encouraging. Keep responses under 60 words.`,
          },
          {
            role: 'user',
            content: `A user painted a greeting-like shape (wavy line or smiley pattern) on the shared canvas. Respond warmly as if they said hello.`,
          },
        ],
        max_tokens: 100,
        temperature: 0.9,
      });

      const aiMessage = response.choices[0]?.message?.content || 'Hello! Great to see you painting!';

      broadcastToRoom(roomId, {
        type: 'ai_response',
        message: aiMessage,
        relatedTo: 'greeting',
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('LLM error:', err.message);
    }
  }
}

function analyzeStroke(points) {
  if (points.length < 10) return { type: 'unknown' };

  const firstThird = points.slice(0, Math.floor(points.length / 3));
  const lastThird = points.slice(-Math.floor(points.length / 3));

  const startX = firstThird[0].x;
  const startY = firstThird[0].y;
  const endX = lastThird[lastThird.length - 1].x;
  const endY = lastThird[lastThird.length - 1].y;

  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const width = maxX - minX;
  const height = maxY - minY;

  // Detect vertical strokes (potential letters)
  if (height > width * 0.7 && height > 30) {
    // Analyze curvature to guess the letter
    const midX = points[Math.floor(points.length / 2)].x;
    const midY = points[Math.floor(points.length / 2)].y;

    // Check for curves to the right (like 'b', 'd', 'h', 'k')
    const rightPoints = points.filter(p => p.x > startX + 5);
    if (rightPoints.length > points.length * 0.3) {
      return { type: 'letter', letter: 'b' };
    }

    // Check for curves to the left (like 'a', 'e', 'c')
    const leftPoints = points.filter(p => p.x < startX - 5);
    if (leftPoints.length > points.length * 0.3) {
      return { type: 'letter', letter: 'a' };
    }

    // Straight vertical line (like 'l', 'i', 't')
    const variance = points.reduce((sum, p) => sum + Math.pow(p.x - startX, 2), 0) / points.length;
    if (variance < 50) {
      return { type: 'letter', letter: 'l' };
    }

    return { type: 'letter', letter: '?' };
  }

  // Detect horizontal strokes (potential 'e', 'f', 't')
  if (width > height * 1.5 && width > 30) {
    return { type: 'letter', letter: 'e' };
  }

  // Detect circular shapes (potential 'o', 'a', 'd')
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

  // Detect smiley/wavy pattern (greeting)
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

async function handleAIChat(room, message, userId) {
  if (!openai) return;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are a friendly art assistant in a collaborative painting app called Happy Paint. Users can chat with you about their artwork. Be helpful, creative, and encouraging. Keep responses under 80 words.`,
        },
        {
          role: 'user',
          content: message,
        },
      ],
      max_tokens: 150,
      temperature: 0.8,
    });

    const aiMessage = response.choices[0]?.message?.content || "I'm here to help with your art!";

    broadcastToRoom(roomId, {
      type: 'ai_message',
      message: aiMessage,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('LLM chat error:', err.message);
    broadcastToRoom(roomId, {
      type: 'ai_message',
      message: "Sorry, I'm having trouble connecting right now. Keep painting!",
      timestamp: Date.now(),
    });
  }
}

// HTTP routes
app.use(express.json());

// API proxy for OpenAI (to avoid exposing API key in browser)
app.post('/api/chat', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'AI not configured. Set OPENAI_API_KEY environment variable.' });
  }

  try {
    const { messages } = req.body;
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      max_tokens: 200,
      temperature: 0.8,
    });

    res.json({
      reply: response.choices[0]?.message?.content || '',
    });
  } catch (err) {
    console.error('API proxy error:', err.message);
    res.status(500).json({ error: 'AI service error: ' + err.message });
  }
});

app.get('/api/status', (req, res) => {
  const roomCount = rooms.size;
  let userCount = 0;
  rooms.forEach(room => { userCount += room.users.size; });

  res.json({
    status: 'online',
    rooms: roomCount,
    users: userCount,
    aiConfigured: !!openai,
  });
});

// Serve built files in production
if (!isDev) {
  const distPath = join(__dirname, 'dist');
  app.use(express.static(distPath));

  app.get('*', (req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`Happy Paint server running on port ${PORT}`);
  if (isDev) {
    console.log(`Frontend dev server: http://localhost:${VITE_PORT}`);
    console.log('Connect to WebSocket: ws://localhost:' + PORT);
  } else {
    console.log('Production mode - serve with: npm run build && npm start');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  wss.close();
  server.close();
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  wss.close();
  server.close();
});
