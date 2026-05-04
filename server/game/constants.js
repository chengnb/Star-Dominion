// Chunk system — world is infinite, divided into chunks
const CHUNK_SIZE = 2000; // each chunk is 2000×2000 world units
const PLANETS_PER_CHUNK = 10; // target planets per chunk

// Spatial grid cell size — cells this size form the culling grid
const CELL_SIZE = 500;

// Game loop tick rate (ticks per second)
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

// Planet generation
const PLANET_MIN_DISTANCE = 150; // minimum distance between planets
const PLANET_RADIUS = 20; // visual radius

// Planet types & resource generation (per second)
const PLANET_TYPES = {
  rocky: { name: '岩石行星', minerals: 3, energy: 1, color: '#8B4513' },
  gas: { name: '气态巨行星', minerals: 1, energy: 3, color: '#DAA520' },
  terran: { name: '类地行星', minerals: 2, energy: 2, color: '#228B22' },
};

// Starting resources for new players
const START_MINERALS = 500;
const START_ENERGY = 500;
const START_TECH = 1;

// Ship definitions
const SHIP_TYPES = {
  scout: { name: '侦察机', minerals: 50, energy: 30, speed: 180, hp: 30, damage: 5, buildTime: 3 },
  fighter: { name: '战斗机', minerals: 100, energy: 50, speed: 130, hp: 80, damage: 15, buildTime: 5 },
  battleship: { name: '战列舰', minerals: 250, energy: 150, speed: 80, hp: 250, damage: 40, buildTime: 10 },
};

// Colony ship for capturing neutral planets
const COLONY_SHIP_COST = { minerals: 300, energy: 200 };

// Defense upgrade cost per level
const DEFENSE_UPGRADE_COST = { minerals: 200, energy: 100 };
const DEFENSE_DAMAGE_PER_LEVEL = 20;
const DEFENSE_HP_PER_LEVEL = 100;

// Viewport culling — how far (in world units) a client can see
const VIEW_RADIUS = 800;

// Fleet combat happens when two hostile fleets are within this range
const COMBAT_RANGE = 30;

// Save interval (ms) for persisting game state
const SAVE_INTERVAL = 30000; // every 30 seconds

module.exports = {
  CHUNK_SIZE,
  PLANETS_PER_CHUNK,
  CELL_SIZE,
  TICK_RATE,
  TICK_MS,
  PLANET_MIN_DISTANCE,
  PLANET_RADIUS,
  PLANET_TYPES,
  START_MINERALS,
  START_ENERGY,
  START_TECH,
  SHIP_TYPES,
  COLONY_SHIP_COST,
  DEFENSE_UPGRADE_COST,
  DEFENSE_DAMAGE_PER_LEVEL,
  DEFENSE_HP_PER_LEVEL,
  VIEW_RADIUS,
  COMBAT_RANGE,
  SAVE_INTERVAL,
};
