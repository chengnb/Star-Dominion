const fs = require('fs');
const path = require('path');

class JSONDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  init() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = { users: [], nextUserId: 1, gameState: null };
      this._persist();
    }
  }

  _persist() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // ── user operations ────────────────────────────────────
  createUser(username, passwordHash) {
    if (this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return { error: '用户名已存在' };
    }
    const user = {
      id: this.data.nextUserId++,
      username,
      passwordHash,
      createdAt: Date.now(),
    };
    this.data.users.push(user);
    this._persist();
    return { user };
  }

  getUser(username) {
    return this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
  }

  getUserById(id) {
    return this.data.users.find(u => u.id === id) || null;
  }

  // ── game state persistence ─────────────────────────────
  saveGameState(state) {
    this.data.gameState = state;
    this._persist();
  }

  getGameState() {
    return this.data.gameState || null;
  }

  getPlayerState(userId) {
    const gs = this.data.gameState;
    if (!gs || !gs.playerStates) return null;
    return gs.playerStates[userId] || null;
  }
}

module.exports = JSONDatabase;
