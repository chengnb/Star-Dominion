const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const GameWorld = require('./game/GameWorld');
const PgDatabase = require('./db');
const { TICK_MS, SAVE_INTERVAL } = require('./game/constants');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'star-dominion-secret-key-change-in-production';
const CLIENT_DIR = path.join(__dirname, '..', 'client');

// ── init ───────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 5000,
  pingTimeout: 15000,
});

app.use(express.static(CLIENT_DIR));

const db = new PgDatabase();
const world = new GameWorld();
world.db = db;

// ── Socket.IO auth middleware ──────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    next();
  } catch {
    next();
  }
});

// ── connection handler ─────────────────────────────────────
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
    const result = await db.createUser(username, hash);
    if (result.error) {
      return cb({ success: false, error: result.error });
    }

    const token = jwt.sign({ userId: result.user.id, username }, JWT_SECRET, { expiresIn: '7d' });
    socket.userId = result.user.id;
    socket.username = username;
    cb({ success: true, token, userId: result.user.id });
    await _spawnPlayer(socket);
  });

  socket.on('auth:login', async (data, cb) => {
    const { username, password } = data || {};
    if (!username || !password) {
      return cb({ success: false, error: '请输入用户名和密码' });
    }
    const user = await db.getUser(username);
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
    await _spawnPlayer(socket);
  });

  socket.on('auth:token', async (data, cb) => {
    if (socket.userId && socket.username) {
      cb({ success: true });
      await _spawnPlayer(socket);
    } else {
      cb({ success: false, error: '无效的令牌' });
    }
  });

  socket.on('auth:logout', () => {
    if (socket.userId) {
      // Save player state before removing
      const playerState = world.getPlayerState(socket.id);
      if (playerState) {
        db.savePlayerStates({ [socket.userId]: playerState }).catch(err =>
          console.error('[db] Failed to save player state on logout:', err)
        );
      }
    }
    world.removePlayer(socket.id);
    socket.userId = null;
    socket.username = null;
    io.emit('game:leaderboard', world.getLeaderboard());
    socket.emit('auth:loggedOut');
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
    // Save player state immediately on disconnect
    if (socket.userId) {
      const state = world.getPlayerState(socket.id);
      if (state) {
        db.savePlayerStates({ [socket.userId]: state }).catch(err =>
          console.error('[db] Disconnect save failed:', err)
        );
      }
    }
    world.removePlayer(socket.id);
    io.emit('game:leaderboard', world.getLeaderboard());
  });
});

async function _spawnPlayer(socket) {
  if (world.players.has(socket.id)) return;

  const savedState = await db.getPlayerState(socket.userId);
  const player = await world.addPlayer(socket.id, socket.userId, socket.username, savedState);
  if (!player) {
    socket.emit('auth:result', { success: false, error: '无法在游戏世界中找到空闲星球' });
    return;
  }

  // Restore ownership from saved data
  world.restoreOwnership(socket.id, socket.userId);

  socket.emit('game:init', {
    worldState: world.getFullState(socket.id),
    myState: {
      minerals: player.minerals,
      energy: player.energy,
      techLevel: player.techLevel,
      homePlanetId: player.homePlanetId,
    },
    color: player.color,
    homePlanetId: player.homePlanetId,
  });

  io.emit('game:leaderboard', world.getLeaderboard());
}

// ── game loop (setTimeout to avoid overlapping async ticks) ─
let lastSave = Date.now();
let leaderboardTick = 0;
let running = true;
const gameLoop = async () => {
  if (!running) return;
  const tickStart = Date.now();
  try {
    await world.update();

    // Send visible state to each connected player
    for (const [socketId] of world.players) {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        const state = world.getVisibleState(socketId);
        if (state) s.volatile.emit('game:update', state);
      }
    }

    // Broadcast system messages as chat
    for (const msg of world.chatMessages) {
      if (msg.isSystem && !msg._broadcast) {
        msg._broadcast = true;
        io.emit('chat:broadcast', msg);
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
      const saveData = world.toSaveData();
      if (saveData.playerStates && Object.keys(saveData.playerStates).length > 0) {
        await db.savePlayerStates(saveData.playerStates);
      }
      if (saveData.dirtyPlanets && saveData.dirtyPlanets.length > 0) {
        await db.savePlanetsBatch(saveData.dirtyPlanets);
        console.log(`[save] Persisted ${saveData.dirtyPlanets.length} planets to DB`);
      }
      world._pendingSave.clear();
    }
  } catch (err) {
    console.error('[tick] Error:', err);
  }
  // Schedule next tick, accounting for time spent
  const elapsed = Date.now() - tickStart;
  setTimeout(gameLoop, Math.max(1, TICK_MS - elapsed));
};
setTimeout(gameLoop, TICK_MS);

// ── graceful shutdown ──────────────────────────────────────
const shutdown = async () => {
  console.log('[shutdown] Saving state...');
  running = false;
  try {
    const saveData = world.toSaveData();
    if (saveData.playerStates && Object.keys(saveData.playerStates).length > 0) {
      await db.savePlayerStates(saveData.playerStates);
    }
    if (saveData.dirtyPlanets && saveData.dirtyPlanets.length > 0) {
      await db.savePlanetsBatch(saveData.dirtyPlanets);
      console.log(`[shutdown] Persisted ${saveData.dirtyPlanets.length} planets`);
    }
    world._pendingSave.clear();
    await db.close();
  } catch (err) {
    console.error('[shutdown] Save error:', err);
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── start ──────────────────────────────────────────────────
(async () => {
  try {
    await db.init();
    await world.loadFromDB();
    // Ensure starting chunks exist
    await world._ensureStartingChunks();

    server.listen(PORT, () => {
      console.log(`Star Dominion server running on http://localhost:${PORT}`);
      console.log(`Planets: ${world.planets.size} | Chunks: ${world.loadedChunks.size} | Players online: ${world.players.size}`);
    });
  } catch (err) {
    console.error('[startup] Failed to initialize:', err);
    process.exit(1);
  }
})();
