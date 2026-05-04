const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const GameWorld = require('./game/GameWorld');
const JSONDatabase = require('./db');
const { TICK_MS, SAVE_INTERVAL } = require('./game/constants');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'star-dominion-secret-key-change-in-production';
const CLIENT_DIR = path.join(__dirname, '..', 'client');

// ── init ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 5000,
  pingTimeout: 15000,
});

app.use(express.static(CLIENT_DIR));

const db = new JSONDatabase(path.join(__dirname, '..', 'data', 'gamedata.json'));
db.init();

const world = new GameWorld();
world.loadSaveData(db.getGameState());

// ── Socket.IO auth middleware ────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(); // Allow connection without token (will auth later)
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    next();
  } catch {
    next(); // Invalid token — client will re-auth
  }
});

// ── connection handler ───────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('auth:register', async (data, cb) => {
    const { username, password } = data || {};
    if (!username || !password || username.length < 2 || password.length < 4) {
      return cb({ success: false, error: '用户名至少2个字符，密码至少4个字符' });
    }
    if (username.length > 16) {
      return cb({ success: false, error: '用户名最多16个字符' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = db.createUser(username, hash);
    if (result.error) {
      return cb({ success: false, error: result.error });
    }
    const token = jwt.sign({ userId: result.user.id, username }, JWT_SECRET, { expiresIn: '7d' });
    socket.userId = result.user.id;
    socket.username = username;
    cb({ success: true, token, userId: result.user.id });
    _spawnPlayer(socket);
  });

  socket.on('auth:login', async (data, cb) => {
    const { username, password } = data || {};
    if (!username || !password) {
      return cb({ success: false, error: '请输入用户名和密码' });
    }
    const user = db.getUser(username);
    if (!user) {
      return cb({ success: false, error: '用户名不存在' });
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return cb({ success: false, error: '密码错误' });
    }
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    socket.userId = user.id;
    socket.username = user.username;
    cb({ success: true, token, userId: user.id });
    _spawnPlayer(socket);
  });

  socket.on('auth:token', (data, cb) => {
    // Client already connected with token in handshake — just spawn
    if (socket.userId && socket.username) {
      cb({ success: true });
      _spawnPlayer(socket);
    } else {
      cb({ success: false, error: '无效的令牌' });
    }
  });

  socket.on('game:command', (cmd) => {
    if (cmd.type !== 'set_view') {
      console.log(`[cmd] ${socket.id} type=${cmd.type}`, cmd);
    }
    world.enqueueCommand(socket.id, cmd);
  });

  socket.on('chat:message', (text) => {
    const player = world.players.get(socket.id);
    if (!player || !text || text.length > 200) return;
    const msg = world.addChatMessage(player.username, text.substring(0, 200));
    io.emit('chat:broadcast', msg);
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    world.removePlayer(socket.id);
    io.emit('game:leaderboard', world.getLeaderboard());
  });
});

function _spawnPlayer(socket) {
  // Check if player is already in world
  if (world.players.has(socket.id)) return;

  const savedState = db.getPlayerState(socket.userId);
  const player = world.addPlayer(socket.id, socket.userId, socket.username, savedState);
  if (!player) {
    socket.emit('auth:result', { success: false, error: '游戏世界已满，没有空闲星球' });
    return;
  }

  // Restore ownership from saved data
  world.restoreOwnership(socket.id, socket.userId);

  // Send full state to the player
  socket.emit('game:init', {
    worldState: world.getFullState(),
    myState: {
      minerals: player.minerals,
      energy: player.energy,
      techLevel: player.techLevel,
      homePlanetId: player.homePlanetId,
    },
    color: player.color,
    homePlanetId: player.homePlanetId,
  });

  // Broadcast updated leaderboard to everyone
  io.emit('game:leaderboard', world.getLeaderboard());
}

// ── game loop ────────────────────────────────────────────
let lastSave = Date.now();
let leaderboardTick = 0;
setInterval(() => {
  world.update();

  // Send visible state to each connected player
  for (const [socketId] of world.players) {
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      const state = world.getVisibleState(socketId);
      if (state) s.volatile.emit('game:update', state);
    }
  }
  world.clearDirtyPlanets();

  // Broadcast leaderboard every 1 second (20 ticks)
  leaderboardTick++;
  if (leaderboardTick >= 20) {
    leaderboardTick = 0;
    io.emit('game:leaderboard', world.getLeaderboard());
  }

  // Periodic save
  const now = Date.now();
  if (now - lastSave > SAVE_INTERVAL) {
    lastSave = now;
    db.saveGameState(world.toSaveData());
  }
}, TICK_MS);

// ── graceful shutdown ────────────────────────────────────
process.on('SIGINT', () => {
  db.saveGameState(world.toSaveData());
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.saveGameState(world.toSaveData());
  process.exit(0);
});

// ── start ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Star Dominion server running on http://localhost:${PORT}`);
  console.log(`Planets: ${world.planets.size} | Players online: ${world.players.size}`);
});
