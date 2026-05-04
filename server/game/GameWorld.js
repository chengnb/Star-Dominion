const SpatialGrid = require('./SpatialGrid');
const {
  WORLD_WIDTH, WORLD_HEIGHT, TICK_MS, PLANET_COUNT, PLANET_MIN_DISTANCE,
  PLANET_TYPES, START_MINERALS, START_ENERGY, SHIP_TYPES, VIEW_RADIUS,
  COMBAT_RANGE, COLONY_SHIP_COST, DEFENSE_UPGRADE_COST,
  DEFENSE_DAMAGE_PER_LEVEL, DEFENSE_HP_PER_LEVEL,
} = require('./constants');

const PLANET_TYPE_KEYS = Object.keys(PLANET_TYPES);
const SHIP_TYPE_KEYS = Object.keys(SHIP_TYPES);

// ── helpers ──────────────────────────────────────────────
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function emptyShips() {
  return { scout: 0, fighter: 0, battleship: 0 };
}

function totalShips(s) {
  return (s.scout || 0) + (s.fighter || 0) + (s.battleship || 0);
}

function fleetSpeed(ships) {
  // Fleet moves at the speed of its slowest ship type present
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

// ── GameWorld ────────────────────────────────────────────
class GameWorld {
  constructor() {
    this.planets = new Map();
    this.fleets = new Map();
    this.players = new Map();       // socketId → player
    this.userIdToSocket = new Map();// userId  → socketId (for reconnection)
    this.spatialGrid = new SpatialGrid();
    this.nextId = 1;
    this.commandQueue = [];
    this.chatMessages = [];         // last 50 messages
    this.dirtyPlanets = new Set();  // planets changed this tick
    this.tickCount = 0;

    this._generatePlanets();
  }

  // ── planet generation ──────────────────────────────────
  _generatePlanets() {
    const types = [];
    for (const key of PLANET_TYPE_KEYS) {
      for (let i = 0; i < Math.floor(PLANET_COUNT / PLANET_TYPE_KEYS.length); i++) {
        types.push(key);
      }
    }
    while (types.length < PLANET_COUNT) types.push(PLANET_TYPE_KEYS[Math.floor(Math.random() * PLANET_TYPE_KEYS.length)]);

    const planets = [];
    let attempts = 0;
    while (planets.length < PLANET_COUNT && attempts < 5000) {
      attempts++;
      const x = 100 + Math.random() * (WORLD_WIDTH - 200);
      const y = 100 + Math.random() * (WORLD_HEIGHT - 200);
      const tooClose = planets.some(p => dist(p, { x, y }) < PLANET_MIN_DISTANCE);
      if (!tooClose) {
        planets.push({ x, y, type: types[planets.length] });
      }
    }

    for (const p of planets) {
      const id = this.nextId++;
      this.planets.set(id, {
        id,
        x: p.x,
        y: p.y,
        type: p.type,
        ownerId: null,
        defenseLevel: 0,
        garrison: emptyShips(),
        isHome: false,
      });
      this.spatialGrid.insert(id, p.x, p.y);
    }
  }

  // ── player management ──────────────────────────────────
  addPlayer(socketId, userId, username, savedState) {
    // Find an unowned planet for the player's home (or assign one)
    let homePlanet = null;
    if (savedState && savedState.homePlanetId && this.planets.has(savedState.homePlanetId)) {
      homePlanet = this.planets.get(savedState.homePlanetId);
      if (homePlanet.ownerId && homePlanet.ownerId !== socketId) {
        // Home was taken — find a new one
        homePlanet = this._findFreePlanet();
      }
    } else {
      homePlanet = this._findFreePlanet();
    }

    if (!homePlanet) return null; // No free planets

    homePlanet.ownerId = socketId;
    homePlanet.isHome = true;
    homePlanet.defenseLevel = Math.max(1, homePlanet.defenseLevel);
    homePlanet.garrison = { scout: 3, fighter: 2, battleship: 0 };
    this.dirtyPlanets.add(homePlanet.id);

    const minerals = savedState ? savedState.minerals : START_MINERALS;
    const energy = savedState ? savedState.energy : START_ENERGY;

    const colors = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#2c3e50'];
    const color = colors[this.players.size % colors.length];

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
    return player;
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    // Return all planets to neutral (in a real game you'd keep them,
    // but for session-based it's cleaner to release)
    for (const planet of this.planets.values()) {
      if (planet.ownerId === socketId) {
        planet.ownerId = null;
        planet.isHome = false;
        planet.defenseLevel = 0;
        planet.garrison = emptyShips();
        this.dirtyPlanets.add(planet.id);
      }
    }
    // Remove all fleets
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

  _findFreePlanet() {
    for (const planet of this.planets.values()) {
      if (!planet.ownerId) return planet;
    }
    return null;
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

  // ── command processing ─────────────────────────────────
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

    // Validate requested ships are available in garrison
    const garrison = fromPlanet.garrison;
    const requested = ships || emptyShips();
    const actual = emptyShips();
    for (const key of SHIP_TYPE_KEYS) {
      const want = requested[key] || 0;
      actual[key] = Math.min(want, garrison[key] || 0);
      if (actual[key] <= 0) actual[key] = 0;
    }
    if (totalShips(actual) === 0) return;

    // Deduct from garrison
    for (const key of SHIP_TYPE_KEYS) {
      garrison[key] = Math.max(0, (garrison[key] || 0) - actual[key]);
    }
    this.dirtyPlanets.add(fromPlanetId);

    // Create fleet
    const fleetId = this.nextId++;
    // Fleet spawns at the edge of the source planet
    const angle = Math.atan2(toPlanet.y - fromPlanet.y, toPlanet.x - fromPlanet.x);
    const spawnDist = 25;
    const fleet = {
      id: fleetId,
      ownerId: player.socketId,
      fromPlanetId,
      toPlanetId,
      x: fromPlanet.x + Math.cos(angle) * spawnDist,
      y: fromPlanet.y + Math.sin(angle) * spawnDist,
      destX: toPlanet.x,
      destY: toPlanet.y,
      ships: actual,
      isColony: false,
      angle,
    };
    this.fleets.set(fleetId, fleet);
    this.spatialGrid.insert(fleetId, fleet.x, fleet.y);
  }

  _handleBuildShip(cmd) {
    const player = this.players.get(cmd.socketId);
    if (!player) { console.log('[build] player not found:', cmd.socketId); return; }
    const { planetId, shipType } = cmd;
    const planet = this.planets.get(planetId);
    if (!planet) { console.log('[build] planet not found:', planetId); return; }
    if (planet.ownerId !== cmd.socketId) { console.log('[build] not owner:', planet.ownerId, cmd.socketId); return; }

    const typeDef = SHIP_TYPES[shipType];
    if (!typeDef) { console.log('[build] bad ship type:', shipType); return; }
    if (player.minerals < typeDef.minerals || player.energy < typeDef.energy) {
      console.log('[build] insufficient resources:', player.minerals, player.energy, typeDef.minerals, typeDef.energy);
      return;
    }

    player.minerals -= typeDef.minerals;
    player.energy -= typeDef.energy;
    planet.garrison[shipType] = (planet.garrison[shipType] || 0) + 1;
    this.dirtyPlanets.add(planetId);
    console.log(`[build] ${player.username} built ${shipType} at planet ${planetId}. Garrison now:`, planet.garrison);
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
    this.dirtyPlanets.add(cmd.planetId);
  }

  // ── game loop ──────────────────────────────────────────
  update() {
    this.tickCount++;
    const dt = TICK_MS / 1000; // seconds

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

      if (remaining < 2) continue; // Already arrived, handled in _checkArrivals

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

      if (targetPlanet.ownerId === fleet.ownerId) {
        // Friendly planet — merge ships into garrison
        const g = targetPlanet.garrison;
        for (const key of SHIP_TYPE_KEYS) {
          g[key] = (g[key] || 0) + (fleet.ships[key] || 0);
        }
        this.dirtyPlanets.add(targetPlanet.id);
        this._removeFleet(fleetId);
      } else if (!targetPlanet.ownerId) {
        // Neutral planet — capture it (colony or military)
        targetPlanet.ownerId = fleet.ownerId;
        targetPlanet.defenseLevel = 1;
        // Merge remaining ships into garrison
        const g = targetPlanet.garrison;
        for (const key of SHIP_TYPE_KEYS) {
          g[key] = (g[key] || 0) + (fleet.ships[key] || 0);
        }
        this.dirtyPlanets.add(targetPlanet.id);
        this._removeFleet(fleetId);
      } else {
        // Enemy planet — battle
        this._battleAtPlanet(fleet, targetPlanet);
        this.dirtyPlanets.add(targetPlanet.id);
        this._removeFleet(fleetId);
      }
    }
  }

  _battleAtPlanet(fleet, planet) {
    // Fleet attacks planet defenses + garrison
    const defLevel = planet.defenseLevel || 0;
    const defDamage = defLevel * DEFENSE_DAMAGE_PER_LEVEL;
    const defHP = defLevel * DEFENSE_HP_PER_LEVEL;
    const garDamage = fleetDamage(planet.garrison);
    const garHP = fleetHP(planet.garrison);

    const attackerDamage = fleetDamage(fleet.ships);
    const attackerHP = fleetHP(fleet.ships);

    // Attacker deals damage to defender
    const totalDefHP = defHP + garHP;
    const totalDefDmg = defDamage + garDamage;

    // Simple resolution: compare total damage * HP
    const attackerPower = attackerDamage * (attackerHP / 100);
    const defenderPower = totalDefDmg * (totalDefHP / 100);

    if (attackerPower > defenderPower) {
      // Attacker wins — capture planet
      planet.ownerId = fleet.ownerId;
      planet.defenseLevel = Math.max(1, planet.defenseLevel - 1);
      // Surviving ships become garrison
      const survivalRatio = Math.min(1, (attackerPower - defenderPower) / Math.max(1, attackerPower));
      planet.garrison = emptyShips();
      for (const key of SHIP_TYPE_KEYS) {
        planet.garrison[key] = Math.floor((fleet.ships[key] || 0) * survivalRatio);
      }
    } else {
      // Defender wins — reduce garrison
      const survivalRatio = Math.min(1, (defenderPower - attackerPower) / Math.max(1, defenderPower));
      for (const key of SHIP_TYPE_KEYS) {
        planet.garrison[key] = Math.floor((planet.garrison[key] || 0) * survivalRatio);
      }
      // Reduce defense level
      if (planet.defenseLevel > 0 && attackerPower > defenderPower * 0.5) {
        planet.defenseLevel = Math.max(0, planet.defenseLevel - 1);
      }
    }
  }

  _resolveCombat() {
    // Check fleet vs fleet combat
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

    // Remove dead fleets
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

    // Proportional damage distribution
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

  // ── state sync ─────────────────────────────────────────
  getFullState() {
    const planets = [];
    for (const p of this.planets.values()) {
      planets.push({
        id: p.id, x: p.x, y: p.y, type: p.type,
        ownerId: p.ownerId, defenseLevel: p.defenseLevel,
        garrison: { ...p.garrison }, isHome: p.isHome,
      });
    }

    const fleets = [];
    for (const f of this.fleets.values()) {
      fleets.push({
        id: f.id, ownerId: f.ownerId, x: f.x, y: f.y,
        destX: f.destX, destY: f.destY, ships: { ...f.ships },
        angle: f.angle, fromPlanetId: f.fromPlanetId, toPlanetId: f.toPlanetId,
      });
    }

    const players = [];
    for (const p of this.players.values()) {
      players.push({
        socketId: p.socketId, username: p.username, color: p.color,
        homePlanetId: p.homePlanetId,
      });
    }

    return { planets, fleets, players, worldWidth: WORLD_WIDTH, worldHeight: WORLD_HEIGHT };
  }

  /** Return game state visible from (cx, cy) with the given radius */
  getVisibleState(socketId) {
    const player = this.players.get(socketId);
    if (!player) return null;

    const cx = player.viewX;
    const cy = player.viewY;
    const radius = VIEW_RADIUS;

    const visibleIds = this.spatialGrid.query(cx, cy, radius);

    const included = new Set();
    const planets = [];

    // Include planets in viewport
    for (const id of visibleIds) {
      const p = this.planets.get(id);
      if (p && dist(p, { x: cx, y: cy }) < radius + 100) {
        included.add(id);
        planets.push({
          id: p.id, x: p.x, y: p.y, type: p.type,
          ownerId: p.ownerId, defenseLevel: p.defenseLevel,
          isHome: p.isHome,
          garrison: p.ownerId === socketId ? { ...p.garrison } : null,
        });
      }
    }

    // Include dirty planets even if outside viewport (for minimap accuracy)
    for (const id of this.dirtyPlanets) {
      if (!included.has(id)) {
        const p = this.planets.get(id);
        if (p) {
          planets.push({
            id: p.id, x: p.x, y: p.y, type: p.type,
            ownerId: p.ownerId, defenseLevel: p.defenseLevel,
            isHome: p.isHome,
            garrison: p.ownerId === socketId ? { ...p.garrison } : null,
          });
        }
      }
    }

    const fleets = [];
    for (const id of visibleIds) {
      const f = this.fleets.get(id);
      if (f && dist(f, { x: cx, y: cy }) < radius + 100) {
        fleets.push({
          id: f.id, ownerId: f.ownerId, x: f.x, y: f.y,
          destX: f.destX, destY: f.destY, ships: { ...f.ships },
          angle: f.angle, fromPlanetId: f.fromPlanetId, toPlanetId: f.toPlanetId,
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
    const entries = [];
    for (const p of this.players.values()) {
      let planetCount = 0;
      for (const planet of this.planets.values()) {
        if (planet.ownerId === p.socketId) planetCount++;
      }
      entries.push({ username: p.username, color: p.color, planets: planetCount });
    }
    entries.sort((a, b) => b.planets - a.planets);
    return entries.slice(0, 20);
  }

  addChatMessage(username, text) {
    const msg = { username, text, time: Date.now() };
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 50) this.chatMessages.shift();
    return msg;
  }

  // ── persistence ────────────────────────────────────────
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

    const planetOwnership = {};
    for (const [id, planet] of this.planets) {
      if (planet.ownerId) {
        const player = this.players.get(planet.ownerId);
        if (player) {
          planetOwnership[id] = {
            ownerUserId: player.userId,
            defenseLevel: planet.defenseLevel,
            isHome: planet.isHome,
            garrison: planet.garrison,
          };
        }
      }
    }

    return { playerStates, planetOwnership };
  }

  loadSaveData(data) {
    if (!data || !data.planetOwnership) return;
    for (const [idStr, info] of Object.entries(data.planetOwnership)) {
      const planet = this.planets.get(Number(idStr));
      if (!planet) continue;
      // We'll reconnect ownership when players join
      planet._savedOwnerUserId = info.ownerUserId;
      planet.defenseLevel = info.defenseLevel;
      planet.isHome = info.isHome;
      planet.garrison = info.garrison || emptyShips();
    }
  }

  /** Call when a player joins: restore ownership of their planets */
  restoreOwnership(socketId, userId) {
    for (const planet of this.planets.values()) {
      if (planet._savedOwnerUserId === userId) {
        planet.ownerId = socketId;
        this.dirtyPlanets.add(planet.id);
        delete planet._savedOwnerUserId;
      }
    }
  }
}

module.exports = GameWorld;
