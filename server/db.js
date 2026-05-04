const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DB_NAME = 'star_dominion';
const DB_CONFIG = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'Aa123456',
};

class PgDatabase {
  constructor() {
    this.pool = null;
    this.ready = false;
  }

  async init() {
    // Ensure database exists
    const setupClient = new (require('pg').Client)({ ...DB_CONFIG, database: 'postgres' });
    try {
      await setupClient.connect();
      const res = await setupClient.query(
        "SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]
      );
      if (res.rows.length === 0) {
        await setupClient.query(`CREATE DATABASE "${DB_NAME}"`);
        console.log('[db] Created database:', DB_NAME);
      }
    } finally {
      await setupClient.end();
    }

    // Connect pool to the game database
    this.pool = new Pool({ ...DB_CONFIG, database: DB_NAME });

    // Create tables
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(16) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS planets (
        id SERIAL PRIMARY KEY,
        chunk_x INT NOT NULL,
        chunk_y INT NOT NULL,
        world_x DOUBLE PRECISION NOT NULL,
        world_y DOUBLE PRECISION NOT NULL,
        type VARCHAR(20) NOT NULL,
        name VARCHAR(50) NOT NULL,
        owner_user_id INT REFERENCES users(id),
        defense_level INT DEFAULT 0,
        is_home BOOLEAN DEFAULT FALSE,
        garrison_scout INT DEFAULT 0,
        garrison_fighter INT DEFAULT 0,
        garrison_battleship INT DEFAULT 0
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_planets_chunk ON planets(chunk_x, chunk_y)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_planets_owner ON planets(owner_user_id)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS player_state (
        user_id INT PRIMARY KEY REFERENCES users(id),
        minerals DOUBLE PRECISION DEFAULT 500,
        energy DOUBLE PRECISION DEFAULT 500,
        tech_level INT DEFAULT 1,
        home_planet_id INT
      )
    `);

    this.ready = true;
    console.log('[db] PostgreSQL connected and initialized');
  }

  // ── user operations ──────────────────────────────────────
  async createUser(username, passwordHash) {
    try {
      const res = await this.pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
        [username, passwordHash]
      );
      return { user: { id: res.rows[0].id, username } };
    } catch (err) {
      if (err.code === '23505') return { error: '用户名已存在' };
      throw err;
    }
  }

  async getUser(username) {
    const res = await this.pool.query(
      'SELECT id, username, password_hash FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return { id: row.id, username: row.username, passwordHash: row.password_hash };
  }

  async getUserById(id) {
    const res = await this.pool.query(
      'SELECT id, username, password_hash FROM users WHERE id = $1', [id]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return { id: row.id, username: row.username, passwordHash: row.password_hash };
  }

  async loadAllUsers() {
    const res = await this.pool.query('SELECT id, username FROM users');
    return new Map(res.rows.map(r => [r.id, r.username]));
  }

  // ── planet operations ────────────────────────────────────
  async insertPlanets(planets) {
    // Batch insert planets and return them with IDs
    const results = [];
    for (const p of planets) {
      const res = await this.pool.query(
        `INSERT INTO planets (chunk_x, chunk_y, world_x, world_y, type, name)
         VALUES ($1,$2,$3,$4,$5,'')
         RETURNING id`,
        [p.chunkX, p.chunkY, p.x, p.y, p.type]
      );
      const id = res.rows[0].id;
      const name = `行星-${id}`;
      await this.pool.query('UPDATE planets SET name = $1 WHERE id = $2', [name, id]);
      results.push({ ...p, id, name });
    }
    return results;
  }

  async loadAllPlanets() {
    const res = await this.pool.query('SELECT * FROM planets ORDER BY id');
    return res.rows.map(row => ({
      id: row.id,
      chunkX: row.chunk_x,
      chunkY: row.chunk_y,
      x: row.world_x,
      y: row.world_y,
      type: row.type,
      name: row.name,
      ownerUserId: row.owner_user_id,
      defenseLevel: row.defense_level,
      isHome: row.is_home,
      garrison: {
        scout: row.garrison_scout || 0,
        fighter: row.garrison_fighter || 0,
        battleship: row.garrison_battleship || 0,
      },
    }));
  }

  async loadChunkedPlanets() {
    // Returns map of "cx,cy" → Set for loaded chunk tracking
    const res = await this.pool.query('SELECT DISTINCT chunk_x, chunk_y FROM planets');
    const chunks = new Set();
    for (const row of res.rows) {
      chunks.add(`${row.chunk_x},${row.chunk_y}`);
    }
    return chunks;
  }

  async getNextPlanetId() {
    const res = await this.pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM planets");
    return res.rows[0].next_id;
  }

  // ── planet state updates ─────────────────────────────────
  async updatePlanet(planet) {
    await this.pool.query(
      `UPDATE planets SET
        owner_user_id = $1, defense_level = $2, is_home = $3,
        garrison_scout = $4, garrison_fighter = $5, garrison_battleship = $6
       WHERE id = $7`,
      [
        planet.ownerUserId || null,
        planet.defenseLevel || 0,
        planet.isHome || false,
        planet.garrison?.scout || 0,
        planet.garrison?.fighter || 0,
        planet.garrison?.battleship || 0,
        planet.id,
      ]
    );
  }

  async savePlanetsBatch(planets) {
    // Efficient batch update of planet states
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of planets) {
        await client.query(
          `UPDATE planets SET
            owner_user_id = $1, defense_level = $2, is_home = $3,
            garrison_scout = $4, garrison_fighter = $5, garrison_battleship = $6
           WHERE id = $7`,
          [
            p.ownerUserId || null,
            p.defenseLevel || 0,
            p.isHome || false,
            p.garrison?.scout || 0,
            p.garrison?.fighter || 0,
            p.garrison?.battleship || 0,
            p.id,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── player state ─────────────────────────────────────────
  async getPlayerState(userId) {
    const res = await this.pool.query(
      'SELECT * FROM player_state WHERE user_id = $1', [userId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      minerals: row.minerals,
      energy: row.energy,
      techLevel: row.tech_level,
      homePlanetId: row.home_planet_id,
    };
  }

  async savePlayerStates(playerStates) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [userId, state] of Object.entries(playerStates)) {
        await client.query(
          `INSERT INTO player_state (user_id, minerals, energy, tech_level, home_planet_id)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET
             minerals = EXCLUDED.minerals,
             energy = EXCLUDED.energy,
             tech_level = EXCLUDED.tech_level,
             home_planet_id = EXCLUDED.home_planet_id`,
          [userId, state.minerals, state.energy, state.techLevel, state.homePlanetId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = PgDatabase;
