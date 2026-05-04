/* ── Star Dominion Client: Entry Point & Networking ── */

const socket = io({
  auth: { token: localStorage.getItem('sd_token') || '' },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 20,
});

// ── Auth UI ──────────────────────────────────────────────
const authOverlay = document.getElementById('auth-overlay');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const authTabs = document.querySelectorAll('.auth-tab');
let authMode = 'login';

authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    authTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    authMode = tab.dataset.tab;
    authSubmit.textContent = authMode === 'login' ? '登录' : '注册';
    authError.textContent = '';
  });
});

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  authError.textContent = '';

  if (!username || !password) {
    authError.textContent = '请填写用户名和密码';
    return;
  }

  const eventName = authMode === 'login' ? 'auth:login' : 'auth:register';
  socket.emit(eventName, { username, password }, (result) => {
    if (result.success) {
      localStorage.setItem('sd_token', result.token);
      authOverlay.classList.add('hidden');
    } else {
      authError.textContent = result.error || '操作失败';
    }
  });
});

// ── Socket events ────────────────────────────────────────
let game = null;

socket.on('connect', () => {
  // If we have a token, try token auth
  if (localStorage.getItem('sd_token')) {
    socket.emit('auth:token', {}, (result) => {
      if (!result.success) {
        localStorage.removeItem('sd_token');
        authOverlay.classList.remove('hidden');
      }
    });
  }
});

socket.on('game:init', (data) => {
  console.log('Game initialized', data);
  authOverlay.classList.add('hidden');
  document.getElementById('game-ui').classList.remove('hidden');
  document.getElementById('player-name').textContent = socket.username || '';
  if (!game) {
    game = new StarGame(data);
  } else {
    game.onInit(data);
  }
});

socket.on('game:update', (data) => {
  if (game) game.onUpdate(data);
});

socket.on('game:leaderboard', (data) => {
  if (game) game.onLeaderboard(data);
});

socket.on('chat:broadcast', (msg) => {
  if (game) game.onChatMessage(msg);
});

// ── Chat input ───────────────────────────────────────────
const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text) {
      socket.emit('chat:message', text);
      chatInput.value = '';
    }
  }
  e.stopPropagation();
});
