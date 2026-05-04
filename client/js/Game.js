/* ── Star Dominion Client: Game Rendering & Input ── */

const PLANET_TYPES = {
  rocky: { name: '岩石行星', color: '#8B4513' },
  gas: { name: '气态巨行星', color: '#DAA520' },
  terran: { name: '类地行星', color: '#228B22' },
};

const SHIP_NAMES = { scout: '侦察机', fighter: '战斗机', battleship: '战列舰' };

class StarGame {
  constructor(initData) {
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.minimapCanvas = document.getElementById('minimap');
    this.minimapCtx = this.minimapCanvas.getContext('2d');

    // World state
    this.planets = new Map();
    this.fleets = new Map();
    this.players = new Map();
    this.worldWidth = 5000;
    this.worldHeight = 5000;

    // My state
    this.myState = { minerals: 0, energy: 0 };
    this.homePlanetId = null;
    this.myColor = '#3498db';
    this.selectedPlanetId = null;

    // Camera
    this.camera = { x: 2500, y: 2500, zoom: 1 };
    this.targetZoom = 1;

    // Mouse
    this.mouse = { x: 0, y: 0, worldX: 0, worldY: 0 };
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.dragCamStart = { x: 0, y: 0 };
    this.hoveredPlanetId = null;
    this._lastSelectedPlanetId = null;

    // UI
    this.leaderboard = [];
    this.chatMessages = [];

    // Starfield
    this.stars = this._generateStars(400);

    // Selection glow animation
    this.selectPulse = 0;

    // Event delegation for planet panel (bound once)
    document.getElementById('panel-actions').addEventListener('click', (e) => {
      const btn = e.target.closest('.build-btn');
      if (!btn) return;
      e.stopPropagation();
      this._handleAction(btn.dataset.action);
    });
    document.getElementById('panel-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedPlanetId = null;
      document.getElementById('planet-panel').classList.add('hidden');
    });

    // Bind input events
    this._bindEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());

    // Load init data
    this.onInit(initData);

    // Start render loop
    this._render();
  }

  // ── data handlers ──────────────────────────────────────
  onInit(data) {
    this.worldWidth = data.worldState.worldWidth;
    this.worldHeight = data.worldState.worldHeight;
    this.myState = data.myState;
    this.homePlanetId = data.homePlanetId;
    this.myColor = data.color;

    this.planets.clear();
    for (const p of data.worldState.planets) {
      this.planets.set(p.id, p);
    }
    this.fleets.clear();
    for (const f of data.worldState.fleets) {
      this.fleets.set(f.id, f);
    }
    this.players.clear();
    for (const p of data.worldState.players) {
      this.players.set(p.socketId, p);
    }

    // Center camera on home planet
    const home = this.planets.get(this.homePlanetId);
    if (home) {
      this.camera.x = home.x;
      this.camera.y = home.y;
    }

    this._updateHUD();
    this._drawMinimap();
  }

  onUpdate(data) {
    // Update planets
    for (const p of data.planets) {
      const existing = this.planets.get(p.id);
      if (existing) {
        Object.assign(existing, p);
      }
    }
    // Update fleets
    const activeFleetIds = new Set();
    for (const f of data.fleets) {
      activeFleetIds.add(f.id);
      const existing = this.fleets.get(f.id);
      if (existing) {
        Object.assign(existing, f);
      } else {
        this.fleets.set(f.id, f);
      }
    }
    // Remove stale fleets
    for (const [id] of this.fleets) {
      if (!activeFleetIds.has(id)) this.fleets.delete(id);
    }
    // Update my state
    if (data.myState) {
      this.myState = data.myState;
    }

    this._updateHUD();
    this._drawMinimap();
  }

  onLeaderboard(data) {
    this.leaderboard = data;
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = data.map((e, i) => {
      const colorStyle = e.color ? `color:${e.color}` : '';
      return `<li style="${colorStyle}">${i + 1}. ${this._esc(e.username)} - ${e.planets}🪐</li>`;
    }).join('');
  }

  onChatMessage(msg) {
    this.chatMessages.push(msg);
    if (this.chatMessages.length > 50) this.chatMessages.shift();
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<span class="name">${this._esc(msg.username)}:</span> ${this._esc(msg.text)}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ── HUD ────────────────────────────────────────────────
  _updateHUD() {
    document.getElementById('res-minerals').textContent = Math.floor(this.myState.minerals);
    document.getElementById('res-energy').textContent = Math.floor(this.myState.energy);
    let planetCount = 0;
    for (const p of this.planets.values()) {
      if (p.ownerId === socket.id) planetCount++;
    }
    document.getElementById('res-planets').textContent = planetCount;
    this._refreshPlanetPanel();
  }

  /** Full rebuild — only called when selected planet changes */
  _updatePlanetPanel() {
    const panel = document.getElementById('planet-panel');
    const planet = this.planets.get(this.selectedPlanetId);
    if (!planet) {
      panel.classList.add('hidden');
      this._lastSelectedPlanetId = null;
      return;
    }
    this._lastSelectedPlanetId = this.selectedPlanetId;
    panel.classList.remove('hidden');

    const typeDef = PLANET_TYPES[planet.type] || { name: '未知' };
    const isMine = planet.ownerId === socket.id;
    const owner = this.players.get(planet.ownerId);
    const ownerName = owner ? owner.username : (planet.ownerId ? '未知' : '无');

    document.getElementById('panel-planet-name').textContent =
      `${typeDef.name} ${isMine ? '(我的)' : ''} ${planet.isHome ? '⭐母星' : ''}`;

    let info = `类型: ${typeDef.name}<br>`;
    info += `拥有者: <span style="color:${owner ? owner.color : '#888'}">${ownerName}</span><br>`;
    info += `防御等级: <span id="panel-defense">${planet.defenseLevel}</span><br>`;
    if (planet.garrison) {
      info += `<span id="panel-garrison">驻军: 侦察机${planet.garrison.scout || 0} 战斗机${planet.garrison.fighter || 0} 战列舰${planet.garrison.battleship || 0}</span>`;
    }
    document.getElementById('panel-info').innerHTML = info;

    let actions = '';
    if (isMine) {
      actions += '<button class="build-btn" data-action="build_scout">造 侦察机 (50矿/30能)</button>';
      actions += '<button class="build-btn" data-action="build_fighter">造 战斗机 (100矿/50能)</button>';
      actions += '<button class="build-btn" data-action="build_battleship">造 战列舰 (250矿/150能)</button>';
      actions += '<button class="build-btn" data-action="upgrade">升级防御 (200矿/100能)</button>';
    }
    document.getElementById('panel-actions').innerHTML = actions;
  }

  /** Lightweight refresh — called every tick, only updates text & disabled states */
  _refreshPlanetPanel() {
    const planet = this.planets.get(this.selectedPlanetId);
    if (!planet) return;

    // Update garrison text
    const garrisonEl = document.getElementById('panel-garrison');
    if (garrisonEl && planet.garrison) {
      const g = planet.garrison;
      garrisonEl.textContent = `驻军: 侦察机${g.scout || 0} 战斗机${g.fighter || 0} 战列舰${g.battleship || 0}`;
    }

    // Update defense level
    const defEl = document.getElementById('panel-defense');
    if (defEl) {
      defEl.textContent = planet.defenseLevel;
    }

    // Update button disabled states based on current resources
    const costs = {
      build_scout: { m: 50, e: 30 },
      build_fighter: { m: 100, e: 50 },
      build_battleship: { m: 250, e: 150 },
      upgrade: { m: 200, e: 100 },
    };
    for (const btn of document.querySelectorAll('#panel-actions .build-btn')) {
      const c = costs[btn.dataset.action];
      if (c) {
        btn.disabled = this.myState.minerals < c.m || this.myState.energy < c.e;
      }
    }
  }

  _handleAction(action) {
    const planet = this.planets.get(this.selectedPlanetId);
    if (!planet || planet.ownerId !== socket.id) {
      console.warn('[build] Cannot build: planet not owned or not selected');
      return;
    }
    console.log('[build] Sending command:', action, 'planet:', planet.id);
    switch (action) {
      case 'build_scout':
        socket.emit('game:command', { type: 'build_ship', planetId: planet.id, shipType: 'scout' });
        break;
      case 'build_fighter':
        socket.emit('game:command', { type: 'build_ship', planetId: planet.id, shipType: 'fighter' });
        break;
      case 'build_battleship':
        socket.emit('game:command', { type: 'build_ship', planetId: planet.id, shipType: 'battleship' });
        break;
      case 'upgrade':
        socket.emit('game:command', { type: 'upgrade_defense', planetId: planet.id });
        break;
    }
  }

  // ── events ─────────────────────────────────────────────
  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _screenToWorld(sx, sy) {
    return {
      x: (sx - this.canvas.width / 2) / this.camera.zoom + this.camera.x,
      y: (sy - this.canvas.height / 2) / this.camera.zoom + this.camera.y,
    };
  }

  _onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - rect.left;
    this.mouse.y = e.clientY - rect.top;
    const world = this._screenToWorld(this.mouse.x, this.mouse.y);
    this.mouse.worldX = world.x;
    this.mouse.worldY = world.y;

    if (e.button === 0) {
      // Left click: check if clicking a planet
      const clicked = this._findPlanetAt(world.x, world.y);
      if (clicked) {
        this.selectedPlanetId = clicked.id;
        this._updatePlanetPanel();
      }
      // Start drag
      this.dragging = true;
      this.dragStart = { x: this.mouse.x, y: this.mouse.y };
      this.dragCamStart = { x: this.camera.x, y: this.camera.y };
    }

    if (e.button === 2) {
      // Right click: send fleet from selected planet to clicked planet
      const clicked = this._findPlanetAt(world.x, world.y);
      if (clicked && this.selectedPlanetId && this.selectedPlanetId !== clicked.id) {
        const source = this.planets.get(this.selectedPlanetId);
        if (source && source.ownerId === socket.id) {
          const ships = source.garrison;
          if (ships && (ships.scout > 0 || ships.fighter > 0 || ships.battleship > 0)) {
            socket.emit('game:command', {
              type: 'send_fleet',
              fromPlanetId: this.selectedPlanetId,
              toPlanetId: clicked.id,
              ships: { scout: ships.scout || 0, fighter: ships.fighter || 0, battleship: ships.battleship || 0 },
            });
            // Optimistically clear garrison (server update will confirm)
            source.garrison = { scout: 0, fighter: 0, battleship: 0 };
            this._updateHUD();
          }
        }
      }
    }
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - rect.left;
    this.mouse.y = e.clientY - rect.top;
    const world = this._screenToWorld(this.mouse.x, this.mouse.y);
    this.mouse.worldX = world.x;
    this.mouse.worldY = world.y;

    if (this.dragging) {
      const dx = this.mouse.x - this.dragStart.x;
      const dy = this.mouse.y - this.dragStart.y;
      this.camera.x = this.dragCamStart.x - dx / this.camera.zoom;
      this.camera.y = this.dragCamStart.y - dy / this.camera.zoom;
      this._clampCamera();
    }

    // Hover detection
    this.hoveredPlanetId = this._findPlanetAt(world.x, world.y)?.id || null;
    this.canvas.classList.toggle('pointing', !!this.hoveredPlanetId);

    // Send view position to server periodically
    if (this._lastViewSend && Date.now() - this._lastViewSend < 500) return;
    this._lastViewSend = Date.now();
    socket.volatile.emit('game:command', {
      type: 'set_view',
      x: this.camera.x,
      y: this.camera.y,
    });
  }

  _onMouseUp(e) {
    this.dragging = false;
  }

  _onWheel(e) {
    e.preventDefault();
    this.targetZoom *= (e.deltaY > 0 ? 0.85 : 1.15);
    this.targetZoom = Math.max(0.25, Math.min(3, this.targetZoom));
  }

  _onKeyDown(e) {
    switch (e.key.toLowerCase()) {
      case 'h':
        // Go home
        const home = this.planets.get(this.homePlanetId);
        if (home) {
          this.camera.x = home.x;
          this.camera.y = home.y;
          this.selectedPlanetId = home.id;
          this._updatePlanetPanel();
        }
        break;
      case 'escape':
        this.selectedPlanetId = null;
        document.getElementById('planet-panel').classList.add('hidden');
        break;
    }
  }

  _findPlanetAt(wx, wy) {
    const threshold = 22 / this.camera.zoom;
    let closest = null;
    let closestDist = threshold;
    for (const p of this.planets.values()) {
      const dx = p.x - wx;
      const dy = p.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < closestDist) {
        closestDist = d;
        closest = p;
      }
    }
    return closest;
  }

  _clampCamera() {
    // Allow some overshoot
    const pad = 200;
    this.camera.x = Math.max(-pad, Math.min(this.worldWidth + pad, this.camera.x));
    this.camera.y = Math.max(-pad, Math.min(this.worldHeight + pad, this.camera.y));
  }

  // ── resize ─────────────────────────────────────────────
  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // ── render ─────────────────────────────────────────────
  _render() {
    requestAnimationFrame(() => this._render());

    // Smooth zoom
    this.camera.zoom += (this.targetZoom - this.camera.zoom) * 0.15;

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cam = this.camera;

    ctx.clearRect(0, 0, w, h);

    // Draw starfield background (parallax)
    this._drawStarfield(ctx, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // Grid (subtle)
    this._drawGrid(ctx);

    // Planet connections for own planets
    this._drawConnections(ctx);

    // Planets
    for (const planet of this.planets.values()) {
      if (!this._inView(planet.x, planet.y, 100)) continue;
      this._drawPlanet(ctx, planet);
    }

    // Fleets
    for (const fleet of this.fleets.values()) {
      if (!this._inView(fleet.x, fleet.y, 50)) continue;
      this._drawFleet(ctx, fleet);
    }

    // Selection indicator
    if (this.selectedPlanetId) {
      const sp = this.planets.get(this.selectedPlanetId);
      if (sp) {
        this.selectPulse += 0.05;
        const pulse = 1 + Math.sin(this.selectPulse) * 0.15;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3 * pulse / cam.zoom;
        ctx.setLineDash([6 / cam.zoom, 4 / cam.zoom]);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 28 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();

    // Hover tooltip
    if (this.hoveredPlanetId) {
      const hp = this.planets.get(this.hoveredPlanetId);
      if (hp) {
        const typeDef = PLANET_TYPES[hp.type] || { name: '未知' };
        const owner = this.players.get(hp.ownerId);
        const ownerName = owner ? owner.username : (hp.ownerId ? '未知' : '中立');
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(this.mouse.x + 16, this.mouse.y - 8, 120, 20);
        ctx.fillStyle = '#fff';
        ctx.font = '12px "Microsoft YaHei", sans-serif';
        ctx.fillText(`${typeDef.name} - ${ownerName}`, this.mouse.x + 20, this.mouse.y + 6);
      }
    }
  }

  _drawStarfield(ctx, w, h) {
    for (const star of this.stars) {
      const sx = (star.x - this.camera.x * 0.3) % w;
      const sy = (star.y - this.camera.y * 0.3) % h;
      const x = ((sx % w) + w) % w;
      const y = ((sy % h) + h) % h;
      ctx.fillStyle = star.brightness;
      ctx.beginPath();
      ctx.arc(x, y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawGrid(ctx) {
    const step = 200;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1 / this.camera.zoom;

    const x0 = Math.floor((this.camera.x - this.canvas.width / this.camera.zoom) / step) * step;
    const y0 = Math.floor((this.camera.y - this.canvas.height / this.camera.zoom) / step) * step;

    ctx.beginPath();
    for (let x = x0; x < this.camera.x + this.canvas.width / this.camera.zoom + step; x += step) {
      if (x < 0 || x > this.worldWidth) continue;
      ctx.moveTo(x, Math.max(0, y0));
      ctx.lineTo(x, Math.min(this.worldHeight, y0 + this.canvas.height / this.camera.zoom + step));
    }
    for (let y = y0; y < this.camera.y + this.canvas.height / this.camera.zoom + step; y += step) {
      if (y < 0 || y > this.worldHeight) continue;
      ctx.moveTo(Math.max(0, x0), y);
      ctx.lineTo(Math.min(this.worldWidth, x0 + this.canvas.width / this.camera.zoom + step), y);
    }
    ctx.stroke();

    // World border
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.strokeRect(0, 0, this.worldWidth, this.worldHeight);
  }

  _drawConnections(ctx) {
    const myPlanets = [];
    for (const p of this.planets.values()) {
      if (p.ownerId === socket.id) myPlanets.push(p);
    }
    if (myPlanets.length < 2) return;

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.beginPath();
    for (let i = 0; i < myPlanets.length; i++) {
      for (let j = i + 1; j < myPlanets.length; j++) {
        const d = Math.hypot(myPlanets[i].x - myPlanets[j].x, myPlanets[i].y - myPlanets[j].y);
        if (d < 600) {
          ctx.moveTo(myPlanets[i].x, myPlanets[i].y);
          ctx.lineTo(myPlanets[j].x, myPlanets[j].y);
        }
      }
    }
    ctx.stroke();
  }

  _drawPlanet(ctx, planet) {
    const typeDef = PLANET_TYPES[planet.type] || { color: '#888' };
    const owner = this.players.get(planet.ownerId);
    const color = owner ? owner.color : '#666';
    const radius = 16 + planet.defenseLevel * 2;

    // Glow for owned planets
    if (owner) {
      const gradient = ctx.createRadialGradient(planet.x, planet.y, radius * 0.5, planet.x, planet.y, radius * 2);
      gradient.addColorStop(0, color + '44');
      gradient.addColorStop(1, 'transparent');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(planet.x, planet.y, radius * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Planet body
    const bodyGrad = ctx.createRadialGradient(planet.x - 3, planet.y - 3, radius * 0.2, planet.x, planet.y, radius);
    bodyGrad.addColorStop(0, this._lighten(typeDef.color, 0.3));
    bodyGrad.addColorStop(1, typeDef.color);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.arc(planet.x, planet.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Owner ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 / this.camera.zoom;
    ctx.beginPath();
    ctx.arc(planet.x, planet.y, radius + 4 / this.camera.zoom, 0, Math.PI * 2);
    ctx.stroke();

    // Home star indicator
    if (planet.isHome) {
      ctx.fillStyle = '#f1c40f';
      ctx.font = `${14 / this.camera.zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('⭐', planet.x, planet.y - radius - 8 / this.camera.zoom);
    }

    // Name label (only when zoomed in enough)
    if (this.camera.zoom > 0.6) {
      ctx.fillStyle = '#ddd';
      ctx.font = `${11 / this.camera.zoom}px "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      const label = typeDef.name;
      ctx.fillText(label, planet.x, planet.y + radius + 14 / this.camera.zoom);
    }

    // Defense pips
    if (planet.defenseLevel > 1) {
      ctx.fillStyle = '#e74c3c';
      for (let i = 0; i < Math.min(planet.defenseLevel - 1, 5); i++) {
        const angle = (i / Math.min(planet.defenseLevel, 5)) * Math.PI * 2 - Math.PI / 2;
        const px = planet.x + Math.cos(angle) * (radius + 10 / this.camera.zoom);
        const py = planet.y + Math.sin(angle) * (radius + 10 / this.camera.zoom);
        ctx.beginPath();
        ctx.arc(px, py, 3 / this.camera.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawFleet(ctx, fleet) {
    const ships = fleet.ships;
    const total = (ships.scout || 0) + (ships.fighter || 0) + (ships.battleship || 0);
    if (total === 0) return;

    const owner = this.players.get(fleet.ownerId);
    const color = owner ? owner.color : '#999';

    // Draw triangle in fleet direction
    const size = 6 + Math.min(total, 20) * 1.2;
    const angle = fleet.angle || 0;

    ctx.save();
    ctx.translate(fleet.x, fleet.y);
    ctx.rotate(angle);

    ctx.fillStyle = color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, -size * 0.6);
    ctx.lineTo(-size * 0.7, size * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // Ship count label
    ctx.fillStyle = '#fff';
    ctx.font = `${9 / this.camera.zoom}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(total, fleet.x, fleet.y - size - 6 / this.camera.zoom);
  }

  // ── minimap ────────────────────────────────────────────
  _drawMinimap() {
    const mc = this.minimapCtx;
    const mw = this.minimapCanvas.width;
    const mh = this.minimapCanvas.height;
    const scaleX = mw / this.worldWidth;
    const scaleY = mh / this.worldHeight;

    mc.clearRect(0, 0, mw, mh);
    mc.fillStyle = 'rgba(0,0,0,0.8)';
    mc.fillRect(0, 0, mw, mh);

    // Planets
    for (const p of this.planets.values()) {
      const owner = this.players.get(p.ownerId);
      mc.fillStyle = owner ? owner.color : '#444';
      mc.fillRect(p.x * scaleX - 1, p.y * scaleY - 1, 2, 2);
    }

    // Viewport rectangle
    const vw = this.canvas.width / this.camera.zoom;
    const vh = this.canvas.height / this.camera.zoom;
    const vx = (this.camera.x - vw / 2) * scaleX;
    const vy = (this.camera.y - vh / 2) * scaleY;
    mc.strokeStyle = '#fff';
    mc.lineWidth = 1;
    mc.strokeRect(vx, vy, vw * scaleX, vh * scaleY);

    // Home planet
    const home = this.planets.get(this.homePlanetId);
    if (home) {
      mc.fillStyle = '#f1c40f';
      mc.fillRect(home.x * scaleX - 2, home.y * scaleY - 2, 4, 4);
    }
  }

  // ── helpers ────────────────────────────────────────────
  _generateStars(count) {
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * 3000,
        y: Math.random() * 2000,
        size: Math.random() * 1.5 + 0.3,
        brightness: `rgba(255,255,255,${Math.random() * 0.5 + 0.15})`,
      });
    }
    return stars;
  }

  _inView(x, y, margin) {
    const vw = this.canvas.width / this.camera.zoom;
    const vh = this.canvas.height / this.camera.zoom;
    return x > this.camera.x - vw / 2 - margin &&
           x < this.camera.x + vw / 2 + margin &&
           y > this.camera.y - vh / 2 - margin &&
           y < this.camera.y + vh / 2 + margin;
  }

  _lighten(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, (num >> 16) + 60);
    const g = Math.min(255, ((num >> 8) & 0x00FF) + 60);
    const b = Math.min(255, (num & 0x0000FF) + 60);
    return `rgb(${r},${g},${b})`;
  }

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
