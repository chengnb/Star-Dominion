const SpatialGrid = require('./SpatialGrid');
const {
  CHUNK_SIZE, PLANETS_PER_CHUNK, TICK_MS, PLANET_MIN_DISTANCE,
  PLANET_TYPES, START_MINERALS, START_ENERGY, SHIP_TYPES, VIEW_RADIUS,
  COMBAT_RANGE, COLONY_SHIP_COST, DEFENSE_UPGRADE_COST,
  DEFENSE_DAMAGE_PER_LEVEL, DEFENSE_HP_PER_LEVEL,
} = require('./constants');

const PLANET_TYPE_KEYS = Object.keys(PLANET_TYPES);
const SHIP_TYPE_KEYS = Object.keys(SHIP_TYPES);

// ── seeded PRNG (mulberry32) ───────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── helpers ────────────────────────────────────────────────
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function emptyShips() {
  return { scout: 0, fighter: 0, battleship: 0 };
}

function totalShips(s) {
  return (s.scout || 0) + (s.fighter || 0) + (s.battleship || 0);
}

function fleetSpeed(ships) {
  let minSpeed = Infinity;
  for (const key of SHIP_TYPE_KEYS) {
    if (ships[key] > 0) {
      minSpeed = Math.min(minSpeed, SHIP_TYPES[key].speed);
    }
  }
  return minSpeed === Infinity ? 100 : minSpeed;
}

function fleetDamage(ships) {
  let dmg = 0;
  for (const key of SHIP_TYPE_KEYS) {
    dmg += (ships[key] || 0) * SHIP_TYPES[key].damage;
  }
  return dmg;
}

function fleetHP(ships) {
  let hp = 0;
  for (const key of SHIP_TYPE_KEYS) {
    hp += (ships[key] || 0) * SHIP_TYPES[key].hp;
  }
  return hp;
}

// ── GameWorld ──────────────────────────────────────────────
class GameWorld {
  constructor() {
    this.planets = new Map();
    this.fleets = new Map();
    this.players = new Map();           // socketId → player
    this.userIdToSocket = new Map();    // userId → socketId
    this.spatialGrid = new SpatialGrid();
    this.nextId = 1;                    // for fleet IDs (planets use DB serial)
    this.commandQueue = [];
    this.chatMessages = [];             // last 100 messages
    this.dirtyPlanets = new Set();   // cleared every tick (network sync)
    this._pendingSave = new Set();  // cleared only on DB save (persistence)
    this.userCache = new Map();     // userId → { username, color }
    this.tickCount = 0;
    this.loadedChunks = new Set();      // "cx,cy" strings
    this.db = null;                     // set after construction
  }

  // ── chunk-based planet generation ────────────────────────
  _chunkKey(cx, cy) {
    return `${cx},${cy}`;
  }

  /** Generate planets for a chunk using a deterministic seed */
  async _generateChunk(cx, cy) {
    const key = this._chunkKey(cx, cy);
    if (this.loadedChunks.has(key)) return;

    const seed = ((cx * 0x9E3779B9 + cy * 0x7F4A7C13) >>> 0);
    const rand = mulberry32(seed);

    const candidates = [];
    const MIN_DIST = PLANET_MIN_DISTANCE;
    let attempts = 0;
    const maxAttempts = PLANETS_PER_CHUNK * 20;

    while (candidates.length < PLANETS_PER_CHUNK && attempts < maxAttempts) {
      attempts++;
      const x = cx * CHUNK_SIZE + 50 + rand() * (CHUNK_SIZE - 100);
      const y = cy * CHUNK_SIZE + 50 + rand() * (CHUNK_SIZE - 100);

      let tooClose = candidates.some(p => dist(p, { x, y }) < MIN_DIST);
      if (!tooClose) {
        tooClose = this._isNearExistingPlanet(x, y, MIN_DIST);
      }
      if (!tooClose) {
        const type = PLANET_TYPE_KEYS[Math.floor(rand() * PLANET_TYPE_KEYS.length)];
        candidates.push({ x, y, type, chunkX: cx, chunkY: cy });
      }
    }

    // Mark loaded even if empty (prevent retry every tick)
    this.loadedChunks.add(key);

    if (candidates.length === 0) {
      console.log(`[world] Chunk (${cx},${cy}) is empty`);
      return;
    }

    // Insert into database and get IDs
    const inserted = await this.db.insertPlanets(candidates);

    for (const p of inserted) {
      this.planets.set(p.id, {
        id: p.id,
        x: p.x,
        y: p.y,
        type: p.type,
        name: p.name,
        ownerId: null,
        ownerUserId: null,
        defenseLevel: 0,
        garrison: emptyShips(),
        isHome: false,
        chunkX: p.chunkX,
        chunkY: p.chunkY,
      });
      this.spatialGrid.insert(p.id, p.x, p.y);
    }

    console.log(`[world] Generated chunk (${cx},${cy}) with ${inserted.length} planets`);
  }

  _isNearExistingPlanet(x, y, minDist) {
    // Check nearby spatial grid cells
    const cellRadius = Math.ceil(minDist / this.spatialGrid.cellSize) + 1;
    const centerCol = Math.floor(x / this.spatialGrid.cellSize);
    const centerRow = Math.floor(y / this.spatialGrid.cellSize);

    for (let r = centerRow - cellRadius; r <= centerRow + cellRadius; r++) {
      for (let c = centerCol - cellRadius; c <= centerCol + cellRadius; c++) {
        const cell = this.spatialGrid.cells.get(`${c},${r}`);
        if (!cell) continue;
        for (const id of cell) {
          const p = this.planets.get(id);
          if (p && dist(p, { x, y }) < minDist) return true;
        }
      }
    }
    return false;
  }

  /** Ensure chunks visible to players are loaded */
  async _loadVisibleChunks() {
    for (const player of this.players.values()) {
      const preloadRange = VIEW_RADIUS + CHUNK_SIZE; // load chunks well ahead of view
      const minCX = Math.floor((player.viewX - preloadRange) / CHUNK_SIZE);
      const maxCX = Math.floor((player.viewX + preloadRange) / CHUNK_SIZE);
      const minCY = Math.floor((player.viewY - preloadRange) / CHUNK_SIZE);
      const maxCY = Math.floor((player.viewY + preloadRange) / CHUNK_SIZE);

      for (let cx = minCX; cx <= maxCX; cx++) {
        for (let cy = minCY; cy <= maxCY; cy++) {
          if (!this.loadedChunks.has(this._chunkKey(cx, cy))) {
            await this._generateChunk(cx, cy);
          }
        }
      }
    }
  }

  /** Generate chunks near origin for initial players */
  async _ensureStartingChunks() {
    // Always generate chunk (0,0) and neighbors so new players have a place to start
    for (let cx = -1; cx <= 1; cx++) {
      for (let cy = -1; cy <= 1; cy++) {
        if (!this.loadedChunks.has(this._chunkKey(cx, cy))) {
          await this._generateChunk(cx, cy);
        }
      }
    }
  }

  // ── load planets from database ───────────────────────────
  async loadFromDB() {
    // Load all users for username/color cache
    const users = await this.db.loadAllUsers();
    for (const [id, username] of users) {
      this._cacheUser(id, username);
    }

    const planets = await this.db.loadAllPlanets();
    for (const p of planets) {
      const userInfo = p.ownerUserId ? this.userCache.get(p.ownerUserId) : null;
      this.planets.set(p.id, {
        id: p.id,
        x: p.x,
        y: p.y,
        type: p.type,
        name: p.name,
        ownerId: null,        // will be restored on player join
        ownerUserId: p.ownerUserId,
        ownerUsername: userInfo ? userInfo.username : null,
        defenseLevel: p.defenseLevel,
        garrison: p.garrison || emptyShips(),
        isHome: p.isHome,
        chunkX: p.chunkX,
        chunkY: p.chunkY,
      });
      this.spatialGrid.insert(p.id, p.x, p.y);
    }

    this.loadedChunks = await this.db.loadChunkedPlanets();
    console.log(`[world] Loaded ${planets.length} planets from DB, ${this.loadedChunks.size} chunks, ${this.userCache.size} users`);
  }

  // ── player management ────────────────────────────────────
  async addPlayer(socketId, userId, username, savedState) {
    // Find a free planet or generate a new chunk
    let homePlanet = null;
    if (savedState && savedState.homePlanetId && this.planets.has(savedState.homePlanetId)) {
      homePlanet = this.planets.get(savedState.homePlanetId);
      // If it's owned by someone else's socket, find another
      if (homePlanet.ownerId && homePlanet.ownerId !== socketId) {
        homePlanet = null;
      }
    }

    if (!homePlanet) {
      // Look for any free planet
      homePlanet = this._findFreePlanet();
    }

    // If still no free planet, generate more chunks
    if (!homePlanet) {
      // Find the furthest loaded chunk and generate next ring
      await this._expandTerritory();
      homePlanet = this._findFreePlanet();
    }

    if (!homePlanet) {
      // Last resort: generate chunks around origin
      await this._ensureStartingChunks();
      homePlanet = this._findFreePlanet();
    }

    if (!homePlanet) return null;

    // Cache user info for offline display
    this._cacheUser(userId, username);

    homePlanet.ownerId = socketId;
    homePlanet.ownerUserId = userId;
    homePlanet.ownerUsername = username;
    homePlanet.isHome = true;
    homePlanet.defenseLevel = Math.max(1, homePlanet.defenseLevel);
    homePlanet.garrison = { scout: 3, fighter: 2, battleship: 0 };
    this._markPlanetDirty(homePlanet.id);

    const minerals = savedState ? savedState.minerals : START_MINERALS;
    const energy = savedState ? savedState.energy : START_ENERGY;

    const userInfo = this.userCache.get(userId);
    const color = userInfo ? userInfo.color : this._userColor(userId);

    const player = {
      socketId,
      userId,
      username,
      minerals,
      energy,
      techLevel: savedState ? savedState.techLevel : 1,
      homePlanetId: homePlanet.id,
      color,
      viewX: homePlanet.x,
      viewY: homePlanet.y,
    };

    this.players.set(socketId, player);
    this.userIdToSocket.set(userId, socketId);

    // Save planet state to DB
    this.db.updatePlanet({
      id: homePlanet.id,
      ownerUserId: userId,
      defenseLevel: homePlanet.defenseLevel,
      isHome: true,
      garrison: homePlanet.garrison,
    }).catch(err => console.error('[db] Failed to save home planet:', err));

    return player;
  }

  /** Release player — clears socketId but keeps userId/defense/garrison for reconnection. */
  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    for (const planet of this.planets.values()) {
      if (planet.ownerId === socketId) {
        planet.ownerId = null; // release socket association only
        // Keep: ownerUserId, defenseLevel, isHome, garrison — persisted in DB
        this._markPlanetDirty(planet.id);
      }
    }
    for (const [id, fleet] of this.fleets) {
      if (fleet.ownerId === socketId) {
        this.spatialGrid.remove(id, fleet.x, fleet.y);
        this.fleets.delete(id);
      }
    }
    if (player.userId) {
      this.userIdToSocket.delete(player.userId);
    }
    this.players.delete(socketId);
  }

  /** Same as removePlayer — soft release for kicks (kept for compat). */
  releasePlayerSocket(socketId) {
    this.removePlayer(socketId);
  }

  getPlayerState(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    return {
      minerals: p.minerals,
      energy: p.energy,
      techLevel: p.techLevel,
      homePlanetId: p.homePlanetId,
    };
  }

  _markPlanetDirty(id) {
    this.dirtyPlanets.add(id);
    this._pendingSave.add(id);
  }

  _userColor(userId) {
    const palette = ['#3498db','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#2c3e50',
                     '#e91e63','#00bcd4','#8bc34a','#ff5722','#607d8b','#cddc39','#795548','#009688'];
    return palette[userId % palette.length];
  }

  _cacheUser(userId, username) {
    if (!this.userCache.has(userId)) {
      this.userCache.set(userId, { username, color: this._userColor(userId) });
    }
  }

  _findFreePlanet() {
    for (const planet of this.planets.values()) {
      if (!planet.ownerId) return planet;
    }
    return null;
  }

  async _expandTerritory() {
    // Find frontier chunks (neighbors of loaded chunks that are not loaded)
    const frontier = new Set();
    for (const key of this.loadedChunks) {
      const [cx, cy] = key.split(',').map(Number);
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nk = this._chunkKey(cx + dx, cy + dy);
        if (!this.loadedChunks.has(nk)) {
          frontier.add(nk);
        }
      }
    }
    // Generate first few frontier chunks
    let count = 0;
    for (const key of frontier) {
      if (count >= 3) break;
      const [cx, cy] = key.split(',').map(Number);
      await this._generateChunk(cx, cy);
      count++;
    }
  }

  /** Restore planet ownership when a player joins */
  restoreOwnership(socketId, userId) {
    for (const planet of this.planets.values()) {
      if (planet.ownerUserId === userId && !planet.ownerId) {
        planet.ownerId = socketId;
        this._markPlanetDirty(planet.id);
      }
    }
  }

  /** Kick an existing socket for the same userId (single-session) */
  kickExistingSession(userId, newSocketId) {
    const existingSocketId = this.userIdToSocket.get(userId);
    if (existingSocketId && existingSocketId !== newSocketId) {
      return existingSocketId;
    }
    return null;
  }

  // ── command processing ───────────────────────────────────
  enqueueCommand(socketId, cmd) {
    this.commandQueue.push({ socketId, ...cmd });
  }

  _processCommands() {
    for (const cmd of this.commandQueue) {
      switch (cmd.type) {
        case 'send_fleet': this._handleSendFleet(cmd); break;
        case 'build_ship': this._handleBuildShip(cmd); break;
        case 'upgrade_defense': this._handleUpgradeDefense(cmd); break;
        case 'set_view': this._handleSetView(cmd); break;
      }
    }
    this.commandQueue.length = 0;
  }

  _handleSetView(cmd) {
    const player = this.players.get(cmd.socketId);
    if (player) {
      player.viewX = cmd.x;
      player.viewY = cmd.y;
    }
  }

  _handleSendFleet(cmd) {
    const player = this.players.get(cmd.socketId);
    if (!player) return;
    const { fromPlanetId, toPlanetId, ships } = cmd;

    const fromPlanet = this.planets.get(fromPlanetId);
    const toPlanet = this.planets.get(toPlanetId);
    if (!fromPlanet || !toPlanet || fromPlanetId === toPlanetId) return;
    if (fromPlanet.ownerId !== cmd.socketId) return;

    const garrison = fromPlanet.garrison;
    const requested = ships || emptyShips();
    const actual = emptyShips();
    for (const key of SHIP_TYPE_KEYS) {
      const want = requested[key] || 0;
      actual[key] = Math.min(want, garrison[key] || 0);
      if (actual[key] <= 0) actual[key] = 0;
    }
    if (totalShips(actual) === 0) return;

    for (const key of SHIP_TYPE_KEYS) {
      garrison[key] = Math.max(0, (garrison[key] || 0) - actual[key]);
    }
    this._markPlanetDirty(fromPlanetId);

    const fleetId = this.nextId++;
    const angle = Math.atan2(toPlanet.y - fromPlanet.y, toPlanet.x - fromPlanet.x);
    const spawnDist = 25;
    const fleet = {
      id: fleetId,
      ownerId: player.socketId,
      ownerUsername: player.username,
      fromPlanetId,
      fromPlanetName: fromPlanet.name,
      toPlanetId,
      toPlanetName: toPlanet.name,
      x: fromPlanet.x + Math.cos(angle) * spawnDist,
      y: fromPlanet.y + Math.sin(angle) * spawnDist,
      destX: toPlanet.x,
      destY: toPlanet.y,
      ships: actual,
      angle,
    };
    this.fleets.set(fleetId, fleet);
    this.spatialGrid.insert(fleetId, fleet.x, fleet.y);
  }

  _handleBuildShip(cmd) {
    const player = this.players.get(cmd.socketId);
    if (!player) return;
    const { planetId, shipType } = cmd;
    const planet = this.planets.get(planetId);
    if (!planet || planet.ownerId !== cmd.socketId) return;

    const typeDef = SHIP_TYPES[shipType];
    if (!typeDef) return;
    if (player.minerals < typeDef.minerals || player.energy < typeDef.energy) return;

    player.minerals -= typeDef.minerals;
    player.energy -= typeDef.energy;
    planet.garrison[shipType] = (planet.garrison[shipType] || 0) + 1;
    this._markPlanetDirty(planetId);
  }

  _handleUpgradeDefense(cmd) {
    const player = this.players.get(cmd.socketId);
    if (!player) return;
    const planet = this.planets.get(cmd.planetId);
    if (!planet || planet.ownerId !== cmd.socketId) return;

    const cost = DEFENSE_UPGRADE_COST;
    if (player.minerals < cost.minerals || player.energy < cost.energy) return;

    player.minerals -= cost.minerals;
    player.energy -= cost.energy;
    planet.defenseLevel++;
    this._markPlanetDirty(cmd.planetId);
  }

  // ── game loop ────────────────────────────────────────────
  async update() {
    this.tickCount++;
    const dt = TICK_MS / 1000;

    await this._loadVisibleChunks();
    this._processCommands();
    this._moveFleets(dt);
    this._checkArrivals();
    this._resolveCombat();
    this._generateResources(dt);
  }

  _moveFleets(dt) {
    for (const fleet of this.fleets.values()) {
      const speed = fleetSpeed(fleet.ships);
      const dx = fleet.destX - fleet.x;
      const dy = fleet.destY - fleet.y;
      const remaining = Math.sqrt(dx * dx + dy * dy);

      if (remaining < 2) continue;

      const step = speed * dt;
      const oldX = fleet.x;
      const oldY = fleet.y;

      if (step >= remaining) {
        fleet.x = fleet.destX;
        fleet.y = fleet.destY;
      } else {
        fleet.x += (dx / remaining) * step;
        fleet.y += (dy / remaining) * step;
      }

      fleet.angle = Math.atan2(fleet.destY - fleet.y, fleet.destX - fleet.x);
      this.spatialGrid.move(fleet.id, oldX, oldY, fleet.x, fleet.y);
    }
  }

  _checkArrivals() {
    const arrived = [];
    for (const [id, fleet] of this.fleets) {
      const d = dist(fleet, { x: fleet.destX, y: fleet.destY });
      if (d < 15) arrived.push(id);
    }

    for (const fleetId of arrived) {
      const fleet = this.fleets.get(fleetId);
      if (!fleet) continue;

      const targetPlanet = this.planets.get(fleet.toPlanetId);
      if (!targetPlanet) {
        this._removeFleet(fleetId);
        continue;
      }

      const ownerPlayer = this.players.get(fleet.ownerId);

      if (targetPlanet.ownerId === fleet.ownerId) {
        // Friendly — merge into garrison
        const g = targetPlanet.garrison;
        for (const key of SHIP_TYPE_KEYS) {
          g[key] = (g[key] || 0) + (fleet.ships[key] || 0);
        }
        this._markPlanetDirty(targetPlanet.id);
        this._addSystemMessage(`${ownerPlayer?.username || '舰队'} 的舰队已抵达己方行星 ${targetPlanet.name}，驻军已合并`);
        this._removeFleet(fleetId);
      } else if (!targetPlanet.ownerId && !targetPlanet.ownerUserId) {
        // Truly neutral planet (never owned) — capture without fight
        targetPlanet.ownerId = fleet.ownerId;
        targetPlanet.ownerUserId = ownerPlayer?.userId || null;
        targetPlanet.ownerUsername = ownerPlayer?.username || null;
        if (ownerPlayer?.userId) this._cacheUser(ownerPlayer.userId, ownerPlayer.username);
        targetPlanet.defenseLevel = 1;
        const g = targetPlanet.garrison;
        for (const key of SHIP_TYPE_KEYS) {
          g[key] = (g[key] || 0) + (fleet.ships[key] || 0);
        }
        this._markPlanetDirty(targetPlanet.id);
        this._addSystemMessage(`${ownerPlayer?.username || '舰队'} 占领了中立行星 ${targetPlanet.name}！`);
        this._removeFleet(fleetId);
      } else {
        // Enemy or disconnected player's planet — battle required
        const prevOwnerName = this.players.get(targetPlanet.ownerId)?.username
          || (targetPlanet.ownerUserId ? `离线玩家#${targetPlanet.ownerUserId}` : '未知');
        const attackerName = ownerPlayer?.username || '未知';
        const won = this._battleAtPlanet(fleet, targetPlanet);
        this._markPlanetDirty(targetPlanet.id);
        if (won) {
          this._addSystemMessage(`${attackerName} 攻占了 ${prevOwnerName} 的行星 ${targetPlanet.name}！`);
        } else {
          this._addSystemMessage(`${attackerName} 对 ${prevOwnerName} 的行星 ${targetPlanet.name} 攻击失败`);
        }
        this._removeFleet(fleetId);
      }
    }
  }

  /** Returns true if attacker won */
  _battleAtPlanet(fleet, planet) {
    const defLevel = planet.defenseLevel || 0;
    const defDamage = defLevel * DEFENSE_DAMAGE_PER_LEVEL;
    const defHP = defLevel * DEFENSE_HP_PER_LEVEL;
    const garDamage = fleetDamage(planet.garrison);
    const garHP = fleetHP(planet.garrison);

    const attackerDamage = fleetDamage(fleet.ships);
    const attackerHP = fleetHP(fleet.ships);

    const totalDefHP = defHP + garHP;
    const totalDefDmg = defDamage + garDamage;

    const attackerPower = attackerDamage * (attackerHP / 100);
    const defenderPower = totalDefDmg * (totalDefHP / 100);

    if (attackerPower > defenderPower) {
      planet.ownerId = fleet.ownerId;
      const ownerPlayer = this.players.get(fleet.ownerId);
      planet.ownerUserId = ownerPlayer?.userId || null;
      planet.ownerUsername = ownerPlayer?.username || fleet.ownerUsername || null;
      if (ownerPlayer?.userId) this._cacheUser(ownerPlayer.userId, ownerPlayer.username);
      planet.defenseLevel = Math.max(1, planet.defenseLevel - 1);
      const survivalRatio = Math.min(1, (attackerPower - defenderPower) / Math.max(1, attackerPower));
      planet.garrison = emptyShips();
      for (const key of SHIP_TYPE_KEYS) {
        planet.garrison[key] = Math.floor((fleet.ships[key] || 0) * survivalRatio);
      }
      return true;
    } else {
      const survivalRatio = Math.min(1, (defenderPower - attackerPower) / Math.max(1, defenderPower));
      for (const key of SHIP_TYPE_KEYS) {
        planet.garrison[key] = Math.floor((planet.garrison[key] || 0) * survivalRatio);
      }
      if (planet.defenseLevel > 0 && attackerPower > defenderPower * 0.5) {
        planet.defenseLevel = Math.max(0, planet.defenseLevel - 1);
      }
      return false;
    }
  }

  _resolveCombat() {
    const fleetIds = Array.from(this.fleets.keys());
    const checked = new Set();

    for (let i = 0; i < fleetIds.length; i++) {
      for (let j = i + 1; j < fleetIds.length; j++) {
        const f1 = this.fleets.get(fleetIds[i]);
        const f2 = this.fleets.get(fleetIds[j]);
        if (!f1 || !f2) continue;
        if (f1.ownerId === f2.ownerId) continue;
        if (dist(f1, f2) < COMBAT_RANGE) {
          this._fleetBattle(f1, f2);
          checked.add(fleetIds[i]);
          checked.add(fleetIds[j]);
        }
      }
    }

    for (const id of checked) {
      const f = this.fleets.get(id);
      if (f && totalShips(f.ships) <= 0) {
        this._removeFleet(id);
      }
    }
  }

  _fleetBattle(f1, f2) {
    const dmg1 = fleetDamage(f1.ships);
    const dmg2 = fleetDamage(f2.ships);
    const hp1 = fleetHP(f1.ships);
    const hp2 = fleetHP(f2.ships);

    const totalDmg = dmg1 + dmg2;
    if (totalDmg === 0) return;

    const loss1 = Math.min(1, (dmg2 / Math.max(1, hp1)) * 0.3);
    const loss2 = Math.min(1, (dmg1 / Math.max(1, hp2)) * 0.3);

    for (const key of SHIP_TYPE_KEYS) {
      f1.ships[key] = Math.max(0, Math.floor((f1.ships[key] || 0) * (1 - loss1)));
      f2.ships[key] = Math.max(0, Math.floor((f2.ships[key] || 0) * (1 - loss2)));
    }
  }

  _generateResources(dt) {
    for (const player of this.players.values()) {
      let mineralIncome = 0;
      let energyIncome = 0;

      for (const planet of this.planets.values()) {
        if (planet.ownerId === player.socketId) {
          const typeDef = PLANET_TYPES[planet.type];
          mineralIncome += typeDef.minerals;
          energyIncome += typeDef.energy;
        }
      }

      player.minerals += mineralIncome * dt;
      player.energy += energyIncome * dt;
    }
  }

  _removeFleet(fleetId) {
    const fleet = this.fleets.get(fleetId);
    if (fleet) {
      this.spatialGrid.remove(fleetId, fleet.x, fleet.y);
      this.fleets.delete(fleetId);
    }
  }

  // ── system messages ──────────────────────────────────────
  _addSystemMessage(text) {
    const msg = { username: '【系统】', text, time: Date.now(), isSystem: true };
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 100) this.chatMessages.shift();
    // Will be broadcast to all clients
  }

  getAndClearSystemMessages() {
    // System messages are stored in chatMessages, they'll be broadcast
    // via the normal chat mechanism. But we mark them separately.
    // Actually, we just emit them in the game loop.
    return null;
  }

  // ── state sync ───────────────────────────────────────────
  getFullState() {
    const planets = [];
    for (const p of this.planets.values()) {
      planets.push({
        id: p.id, x: p.x, y: p.y, type: p.type, name: p.name,
        ownerId: p.ownerId, ownerUserId: p.ownerUserId, ownerUsername: p.ownerUsername,
        defenseLevel: p.defenseLevel, garrison: { ...p.garrison }, isHome: p.isHome,
      });
    }

    const fleets = [];
    for (const f of this.fleets.values()) {
      const fowner = this.players.get(f.ownerId);
      fleets.push({
        id: f.id, ownerId: f.ownerId, ownerUsername: fowner?.username || f.ownerUsername || null,
        x: f.x, y: f.y, destX: f.destX, destY: f.destY, ships: { ...f.ships },
        angle: f.angle, fromPlanetId: f.fromPlanetId, toPlanetId: f.toPlanetId,
        fromPlanetName: f.fromPlanetName, toPlanetName: f.toPlanetName,
      });
    }

    const players = [];
    for (const p of this.players.values()) {
      players.push({
        socketId: p.socketId, username: p.username, color: p.color,
        homePlanetId: p.homePlanetId,
      });
    }

    // Include user cache for offline owner display
    const ownerCache = [];
    for (const [uid, info] of this.userCache) {
      ownerCache.push({ userId: uid, username: info.username, color: info.color });
    }

    return { planets, fleets, players, ownerCache };
  }

  getVisibleState(socketId) {
    const player = this.players.get(socketId);
    if (!player) return null;

    const cx = player.viewX;
    const cy = player.viewY;
    const radius = VIEW_RADIUS;

    const visibleIds = this.spatialGrid.query(cx, cy, radius);

    const included = new Set();
    const planets = [];

    for (const id of visibleIds) {
      const p = this.planets.get(id);
      if (p && dist(p, { x: cx, y: cy }) < radius + 100) {
        included.add(id);
        planets.push({
          id: p.id, x: p.x, y: p.y, type: p.type, name: p.name,
          ownerId: p.ownerId, ownerUserId: p.ownerUserId, ownerUsername: p.ownerUsername,
          defenseLevel: p.defenseLevel, isHome: p.isHome,
          garrison: { ...p.garrison }, // show garrison info for all
        });
      }
    }

    for (const id of this.dirtyPlanets) {
      if (!included.has(id)) {
        const p = this.planets.get(id);
        if (p) {
          planets.push({
            id: p.id, x: p.x, y: p.y, type: p.type, name: p.name,
            ownerId: p.ownerId, ownerUserId: p.ownerUserId, ownerUsername: p.ownerUsername,
            defenseLevel: p.defenseLevel, isHome: p.isHome,
            garrison: { ...p.garrison },
          });
        }
      }
    }

    const fleets = [];
    for (const id of visibleIds) {
      const f = this.fleets.get(id);
      if (f && dist(f, { x: cx, y: cy }) < radius + 100) {
        const fowner = this.players.get(f.ownerId);
        fleets.push({
          id: f.id, ownerId: f.ownerId, ownerUsername: fowner?.username || f.ownerUsername || null,
          x: f.x, y: f.y, destX: f.destX, destY: f.destY, ships: { ...f.ships },
          angle: f.angle, fromPlanetId: f.fromPlanetId, toPlanetId: f.toPlanetId,
          fromPlanetName: f.fromPlanetName, toPlanetName: f.toPlanetName,
        });
      }
    }

    const myState = {
      minerals: player.minerals,
      energy: player.energy,
      techLevel: player.techLevel,
      homePlanetId: player.homePlanetId,
    };

    return { planets, fleets, myState };
  }

  clearDirtyPlanets() {
    this.dirtyPlanets.clear();
  }

  getLeaderboard() {
    // Aggregate: count planets per userId (online + offline)
    const counts = new Map(); // userId → { username, color, planets }
    for (const [uid, info] of this.userCache) {
      counts.set(uid, { username: info.username, color: info.color, planets: 0 });
    }
    for (const planet of this.planets.values()) {
      if (planet.ownerUserId) {
        const entry = counts.get(planet.ownerUserId);
        if (entry) entry.planets++;
      }
    }
    // Also include online players not yet in cache
    for (const p of this.players.values()) {
      if (!counts.has(p.userId)) {
        counts.set(p.userId, { username: p.username, color: p.color, planets: 0 });
      }
    }
    const entries = Array.from(counts.values());
    entries.sort((a, b) => b.planets - a.planets);
    return entries.slice(0, 20);
  }

  addChatMessage(username, text) {
    const msg = { username, text, time: Date.now(), isSystem: false };
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 100) this.chatMessages.shift();
    return msg;
  }

  // ── persistence ──────────────────────────────────────────
  toSaveData() {
    const playerStates = {};
    for (const p of this.players.values()) {
      playerStates[p.userId] = {
        minerals: p.minerals,
        energy: p.energy,
        techLevel: p.techLevel,
        homePlanetId: p.homePlanetId,
      };
    }

    // Save all planets that changed since last save
    const planetList = [];
    for (const id of this._pendingSave) {
      const planet = this.planets.get(id);
      if (planet) {
        planetList.push({
          id: planet.id,
          ownerUserId: planet.ownerUserId,
          defenseLevel: planet.defenseLevel,
          isHome: planet.isHome,
          garrison: planet.garrison,
        });
      }
    }

    return { playerStates, dirtyPlanets: planetList };
  }
}

module.exports = GameWorld;
