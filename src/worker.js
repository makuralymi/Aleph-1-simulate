const WORLD_BOUND = 100000;
const TICK_INTERVAL = 50;
const STAR_MAX = 600;
const STAR_BATCH = 15;
const INITIAL_MASS = 1000;
const SWALLOW_RATIO = 1.3;
const BROADCAST_INTERVAL = 80;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const PERSIST_INTERVAL_MS = 1000;
const RANKING_CACHE_MS = 500;
const STAR_CELL_SIZE = 2200;
const STAR_SPAWN_RADIUS_MIN = 600;   // 新星最小生成半径（单位同世界坐标）
const STAR_SPAWN_RADIUS_MAX = 7000;  // 新星最大生成半径
const STAR_RECYCLE_RADIUS = 14000;   // 超出该半径的星体将被回收（所有玩家均不在附近时）
const STAR_RECYCLE_INTERVAL = 100;   // 每 N tick 执行一次回收（100*50ms=5秒）
const STORAGE_KEY = "worldState";
const PREGENERATED_STARS_KEY = "preGeneratedStars";
const ACCOUNTS_KEY = "accounts";
const ADMIN_USERNAME = "makuraly";
const ADMIN_PASSWORD = "Lxy20040904.com";
const ACCOUNT_NAME_MIN_LEN = 3;
const ACCOUNT_NAME_MAX_LEN = 20;
const PASSWORD_MIN_LEN = 6;
const PASSWORD_MAX_LEN = 64;
const textEncoder = new TextEncoder();

function resetHourUTC() {
  return 20;
}

function nextResetTime() {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(resetHourUTC(), 0, 0, 0);
  if (reset <= now) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.getTime();
}

function randomInBound() {
  return (Math.random() - 0.5) * 2 * (WORLD_BOUND * 0.9);
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function starCellKey(x, z) {
  const cellX = Math.floor(x / STAR_CELL_SIZE);
  const cellZ = Math.floor(z / STAR_CELL_SIZE);
  return `${cellX},${cellZ}`;
}

function clampNum(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, number));
}

function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

function sanitizePlayerName(value) {
  const name = String(value || "").trim().slice(0, 20);
  return name || "匿名黑洞";
}

function normalizeAccountName(value) {
  const name = String(value || "").trim();
  if (name.length < ACCOUNT_NAME_MIN_LEN || name.length > ACCOUNT_NAME_MAX_LEN) return null;
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(name)) return null;
  return name;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < PASSWORD_MIN_LEN || password.length > PASSWORD_MAX_LEN) return null;
  return password;
}

function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > 160) return null;
  return token;
}

async function hashPassword(password, salt) {
  const payload = textEncoder.encode(`${salt}:${password}`);
  const buffer = await crypto.subtle.digest("SHA-256", payload);
  const bytes = new Uint8Array(buffer);
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function generateStar() {
  const roll = Math.random();
  let type;
  let mass;
  let hue;
  let sat;
  let light;

  if (roll < 0.55) {
    type = "asteroid";
    mass = rand(5, 22);
    hue = rand(24, 45);
    sat = rand(45, 70);
    light = rand(50, 67);
  } else if (roll < 0.88) {
    type = "planet";
    mass = rand(22, 86);
    hue = rand(170, 235);
    sat = rand(55, 88);
    light = rand(56, 72);
  } else {
    type = "star";
    mass = rand(86, 180);
    hue = rand(8, 58);
    sat = rand(78, 95);
    light = rand(68, 84);
  }

  return {
    id: crypto.randomUUID(),
    x: randomInBound(),
    z: randomInBound(),
    mass,
    type,
    hue: Math.round(hue),
    sat: Math.round(sat),
    light: Math.round(light),
  };
}

function generateDistributedStars() {
  const stars = [];
  const span = WORLD_BOUND * 1.8;
  const edge = -WORLD_BOUND * 0.9;
  const cellsPerAxis = Math.ceil(Math.sqrt(STAR_MAX));
  const step = span / cellsPerAxis;

  for (let index = 0; index < STAR_MAX; index++) {
    const base = generateStar();
    const gridX = index % cellsPerAxis;
    const gridZ = Math.floor(index / cellsPerAxis);
    const jitterX = rand(-step * 0.35, step * 0.35);
    const jitterZ = rand(-step * 0.35, step * 0.35);
    stars.push({
      ...base,
      x: edge + gridX * step + step * 0.5 + jitterX,
      z: edge + gridZ * step + step * 0.5 + jitterZ,
    });
  }

  return stars;
}

function createInitialStars() {
  return generateDistributedStars();
}

function createFreshPlayer(sessionId, name) {
  return {
    id: sessionId,
    sessionId,
    name,
    x: randomInBound(),
    z: randomInBound(),
    mass: INITIAL_MASS,
    eaten: 0,
    vx: 0,
    vz: 0,
    alive: true,
    connected: false,
    disconnectedAt: null,
    lastUpdate: Date.now(),
  };
}

function serializePlayer(player) {
  return {
    id: player.id,
    sessionId: player.sessionId,
    name: player.name,
    x: player.x,
    z: player.z,
    mass: player.mass,
    eaten: player.eaten,
    vx: player.vx,
    vz: player.vz,
    alive: player.alive,
    connected: Boolean(player.connected),
    disconnectedAt: player.disconnectedAt ?? null,
    lastUpdate: player.lastUpdate ?? Date.now(),
  };
}

function revivePlayer(rawPlayer) {
  return {
    id: rawPlayer.id,
    sessionId: rawPlayer.sessionId || rawPlayer.id,
    name: sanitizePlayerName(rawPlayer.name),
    x: Number(rawPlayer.x) || 0,
    z: Number(rawPlayer.z) || 0,
    mass: Math.max(INITIAL_MASS, Number(rawPlayer.mass) || INITIAL_MASS),
    eaten: Math.max(0, Math.floor(Number(rawPlayer.eaten) || 0)),
    vx: Number(rawPlayer.vx) || 0,
    vz: Number(rawPlayer.vz) || 0,
    alive: rawPlayer.alive !== false,
    connected: Boolean(rawPlayer.connected),
    disconnectedAt: rawPlayer.disconnectedAt ?? null,
    lastUpdate: Number(rawPlayer.lastUpdate) || Date.now(),
  };
}

export class GameWorld {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map();
    this.stars = [];
    this.seasonRanking = [];
    this.nextReset = nextResetTime();
    this.connections = new Map();
    this.tickTimer = null;
    this.broadcastTimer = null;
    this.dirty = false;
    this.lastPersistAt = 0;
    this.flushPromise = null;
    this.cachedRanking = [];
    this.cachedRankingAt = 0;
    this.tickCount = 0;
    this.ready = this.state.blockConcurrencyWhile(async () => {
      await this.loadState();
    });
  }

  async loadState() {
    const snapshot = await this.state.storage.get(STORAGE_KEY);
    if (!snapshot || typeof snapshot !== "object") {
      this.stars = createInitialStars();
      this.nextReset = nextResetTime();
      this.seasonRanking = [];
      this.players.clear();
      this.markDirty();
      await this.flushState(true);
      await this.scheduleNextResetAlarm();
      await this.primeNextSeasonWorld();
      return;
    }

    this.stars = Array.isArray(snapshot.stars) ? snapshot.stars : createInitialStars();
    this.nextReset = Number(snapshot.nextReset) || nextResetTime();
    this.seasonRanking = Array.isArray(snapshot.seasonRanking) ? snapshot.seasonRanking : [];
    this.players.clear();

    if (Array.isArray(snapshot.players)) {
      for (const rawPlayer of snapshot.players) {
        const player = revivePlayer(rawPlayer);
        player.connected = false;
        this.players.set(player.sessionId, player);
      }
    }

    await this.scheduleNextResetAlarm();
  }

  markDirty() {
    this.dirty = true;
    this.cachedRankingAt = 0;
  }

  buildSnapshot() {
    return {
      players: [...this.players.values()].map(serializePlayer),
      stars: this.stars,
      seasonRanking: this.seasonRanking,
      nextReset: this.nextReset,
      savedAt: Date.now(),
    };
  }

  async flushState(force = false) {
    if (!force && !this.dirty) return;
    const now = Date.now();
    if (!force && now - this.lastPersistAt < PERSIST_INTERVAL_MS) return;
    if (this.flushPromise) {
      if (force) await this.flushPromise;
      return;
    }

    const snapshot = this.buildSnapshot();
    this.dirty = false;
    this.flushPromise = this.state.storage.put(STORAGE_KEY, snapshot)
      .catch((error) => {
        this.dirty = true;
        throw error;
      })
      .finally(() => {
        this.lastPersistAt = Date.now();
        this.flushPromise = null;
      });

    await this.flushPromise;
  }

  jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  async readJsonBody(request) {
    try {
      const data = await request.json();
      if (!data || typeof data !== "object") return null;
      return data;
    } catch {
      return null;
    }
  }

  async loadAccounts() {
    const stored = await this.state.storage.get(ACCOUNTS_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  async saveAccounts(accounts) {
    await this.state.storage.put(ACCOUNTS_KEY, accounts);
  }

  async scheduleNextResetAlarm() {
    try {
      await this.state.storage.setAlarm(this.nextReset);
    } catch {
      // ignore alarm setup failure
    }
  }

  async loadPreGeneratedStars() {
    const stored = await this.state.storage.get(PREGENERATED_STARS_KEY);
    if (!Array.isArray(stored) || stored.length < STAR_MAX) return null;
    return stored;
  }

  async consumePreGeneratedStars() {
    const stars = await this.loadPreGeneratedStars();
    if (!stars) return null;
    await this.state.storage.delete(PREGENERATED_STARS_KEY);
    return stars;
  }

  async primeNextSeasonWorld() {
    const nextWorldStars = generateDistributedStars();
    await this.state.storage.put(PREGENERATED_STARS_KEY, nextWorldStars);
  }

  async findAccountByToken(token) {
    const accountToken = normalizeToken(token);
    if (!accountToken) return null;
    const accounts = await this.loadAccounts();
    return accounts.find((account) => account.token === accountToken) || null;
  }

  async registerAccount(payload) {
    const username = normalizeAccountName(payload?.username);
    const password = normalizePassword(payload?.password);
    const nickname = sanitizePlayerName(payload?.nickname || payload?.username);

    if (!username) {
      return this.jsonResponse({ ok: false, error: "账号格式不正确（3-20位，支持中英文、数字、下划线）" }, 400);
    }
    if (!password) {
      return this.jsonResponse({ ok: false, error: "密码长度需为 6-64 位" }, 400);
    }

    const usernameKey = username.toLowerCase();
    if (usernameKey === ADMIN_USERNAME.toLowerCase()) {
      return this.jsonResponse({ ok: false, error: "账号已存在" }, 409);
    }
    const accounts = await this.loadAccounts();
    const exists = accounts.some((account) => account.usernameKey === usernameKey);
    if (exists) {
      return this.jsonResponse({ ok: false, error: "账号已存在" }, 409);
    }

    const nicknameKey = nickname.toLowerCase();
    const nicknameTaken =
      nicknameKey === ADMIN_USERNAME.toLowerCase() ||
      accounts.some((account) => (account.nickname || account.username).toLowerCase() === nicknameKey);
    if (nicknameTaken) {
      return this.jsonResponse({ ok: false, error: "昵称已被使用，请换一个昵称" }, 409);
    }

    const salt = crypto.randomUUID();
    const passwordHash = await hashPassword(password, salt);
    const token = crypto.randomUUID();
    const now = Date.now();

    accounts.push({
      username,
      usernameKey,
      nickname,
      salt,
      passwordHash,
      token,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });

    await this.saveAccounts(accounts);

    return this.jsonResponse({
      ok: true,
      token,
      username,
      nickname,
    });
  }

  async loginAccount(payload) {
    const username = normalizeAccountName(payload?.username);
    const password = normalizePassword(payload?.password);
    if (!username || !password) {
      return this.jsonResponse({ ok: false, error: "账号或密码不正确" }, 400);
    }

    const usernameKey = username.toLowerCase();

    // 固定管理员账号
    if (usernameKey === ADMIN_USERNAME.toLowerCase()) {
      if (password !== ADMIN_PASSWORD) {
        return this.jsonResponse({ ok: false, error: "账号或密码不正确" }, 401);
      }
      const accounts = await this.loadAccounts();
      const token = crypto.randomUUID();
      const now = Date.now();
      let accountIndex = accounts.findIndex((a) => a.usernameKey === usernameKey);
      if (accountIndex === -1) {
        const salt = crypto.randomUUID();
        const passwordHash = await hashPassword(password, salt);
        accounts.push({
          username: ADMIN_USERNAME,
          usernameKey,
          nickname: ADMIN_USERNAME,
          salt,
          passwordHash,
          token,
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        });
      } else {
        accounts[accountIndex].token = token;
        accounts[accountIndex].isAdmin = true;
        accounts[accountIndex].lastLoginAt = now;
        accounts[accountIndex].updatedAt = now;
      }
      await this.saveAccounts(accounts);
      return this.jsonResponse({
        ok: true,
        token,
        username: ADMIN_USERNAME,
        nickname: ADMIN_USERNAME,
        isAdmin: true,
      });
    }

    const accounts = await this.loadAccounts();
    const accountIndex = accounts.findIndex((account) => account.usernameKey === usernameKey);
    if (accountIndex === -1) {
      return this.jsonResponse({ ok: false, error: "账号或密码不正确" }, 401);
    }

    const account = accounts[accountIndex];
    const passwordHash = await hashPassword(password, account.salt);
    if (passwordHash !== account.passwordHash) {
      return this.jsonResponse({ ok: false, error: "账号或密码不正确" }, 401);
    }

    const token = crypto.randomUUID();
    account.token = token;
    account.lastLoginAt = Date.now();
    account.updatedAt = Date.now();
    accounts[accountIndex] = account;
    await this.saveAccounts(accounts);

    return this.jsonResponse({
      ok: true,
      token,
      username: account.username,
      nickname: sanitizePlayerName(account.nickname || account.username),
    });
  }

  async alarm() {
    await this.ready;
    const now = Date.now();
    if (now >= this.nextReset) {
      await this.performDailyReset();
      return;
    }
    await this.scheduleNextResetAlarm();
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const payload = await this.readJsonBody(request);
      if (!payload) return this.jsonResponse({ ok: false, error: "请求体无效" }, 400);
      return this.registerAccount(payload);
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const payload = await this.readJsonBody(request);
      if (!payload) return this.jsonResponse({ ok: false, error: "请求体无效" }, 400);
      return this.loginAccount(payload);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/api/ranking") {
      return this.jsonResponse({
        current: this.getCurrentRanking(),
        lastSeason: this.seasonRanking,
        yesterdayRanking: this.seasonRanking,
        nextReset: this.nextReset,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  handleSession(ws) {
    ws.accept();
    let sessionId = null;

    ws.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "join") {
        const account = await this.findAccountByToken(message.token);
        if (!account) {
          this.sendToSocket(ws, { type: "auth_required", reason: "登录已失效，请重新登录" });
          try {
            ws.close(1008, "auth required");
          } catch {
            // ignore close failure
          }
          return;
        }

        const requestedSessionId = normalizeSessionId(message.sessionId);
        const playerName = sanitizePlayerName(message.name || account.nickname || account.username);
        const isAdmin = account.isAdmin === true || account.usernameKey === ADMIN_USERNAME.toLowerCase();
        const { player, restored } = this.createOrRestorePlayer(requestedSessionId, playerName);
        sessionId = player.sessionId;
        player.isAdmin = isAdmin;
        this.attachConnection(sessionId, ws);
        player.name = playerName;
        player.connected = true;
        player.disconnectedAt = null;
        player.lastUpdate = Date.now();
        this.markDirty();
        await this.flushState(true);

        this.sendToSocket(ws, {
          type: "init",
          id: player.id,
          sessionId: player.sessionId,
          x: player.x,
          z: player.z,
          mass: player.mass,
          eaten: player.eaten,
          stars: this.stars,
          players: this.getPlayersSnapshot({ connectedOnly: false }),
          ranking: this.getCurrentRanking(),
          lastSeason: this.seasonRanking.slice(0, 20),
          nextReset: this.nextReset,
          worldBound: WORLD_BOUND,
          restored,
          isAdmin,
        });

        this.broadcast({
          type: restored ? "player_return" : "player_join",
          id: player.id,
          name: player.name,
          x: player.x,
          z: player.z,
          mass: player.mass,
          eaten: player.eaten,
          alive: player.alive,
        }, sessionId);

        this.ensureLoops();
        return;
      }

      if (!sessionId) return;
      const player = this.players.get(sessionId);
      if (!player) return;

      if (message.type === "move") {
        if (!player.connected || !player.alive) return;
        player.vx = clampNum(message.vx, -400, 400);
        player.vz = clampNum(message.vz, -400, 400);
        player.lastUpdate = Date.now();
        this.markDirty();
        return;
      }

      if (message.type === "respawn") {
        player.x = randomInBound();
        player.z = randomInBound();
        player.mass = INITIAL_MASS;
        player.eaten = 0;
        player.vx = 0;
        player.vz = 0;
        player.alive = true;
        player.lastUpdate = Date.now();
        this.markDirty();
        await this.flushState(true);
        this.sendToSocket(ws, {
          type: "respawn",
          x: player.x,
          z: player.z,
          mass: player.mass,
        });
      }

      if (message.type === "teleport") {
        if (!player.connected || !player.alive || !player.isAdmin) return;
        const tx = clampNum(Number(message.x), -WORLD_BOUND, WORLD_BOUND);
        const tz = clampNum(Number(message.z), -WORLD_BOUND, WORLD_BOUND);
        player.x = tx;
        player.z = tz;
        player.vx = 0;
        player.vz = 0;
        player.lastUpdate = Date.now();
        this.markDirty();
        this.sendToSocket(ws, {
          type: "teleported",
          x: player.x,
          z: player.z,
        });
        return;
      }

      if (message.type === "eat_star") {
        if (!player.connected || !player.alive) return;
        const starId = typeof message.starId === "string" ? message.starId : null;
        if (!starId) return;
        const starIndex = this.stars.findIndex((s) => s.id === starId);
        if (starIndex === -1) return; // 已被消耗（防重复）
        const star = this.stars[starIndex];
        const gain = star.mass * (star.type === "star" ? 1.0 : star.type === "planet" ? 0.88 : 0.68);
        player.mass += gain;
        player.eaten += 1;
        player.lastUpdate = Date.now();
        this.stars.splice(starIndex, 1);
        this.markDirty();
        this.broadcast({ type: "stars_remove", starIds: [starId] });
        return;
      }
    });

    ws.addEventListener("close", () => {
      if (!sessionId) return;
      void this.detachConnection(sessionId);
    });

    ws.addEventListener("error", () => {
      if (!sessionId) return;
      void this.detachConnection(sessionId);
    });
  }

  createOrRestorePlayer(requestedSessionId, playerName) {
    const existing = requestedSessionId ? this.players.get(requestedSessionId) : null;
    if (existing) {
      existing.name = playerName;
      return { player: existing, restored: true };
    }

    const sessionId = requestedSessionId || crypto.randomUUID();
    const player = createFreshPlayer(sessionId, playerName);
    this.players.set(sessionId, player);
    return { player, restored: false };
  }

  attachConnection(sessionId, ws) {
    const existingSocket = this.connections.get(sessionId);
    if (existingSocket && existingSocket !== ws) {
      try {
        existingSocket.close(1012, "replaced");
      } catch {
        // ignore socket close failure
      }
    }
    this.connections.set(sessionId, ws);
  }

  async detachConnection(sessionId) {
    const player = this.players.get(sessionId);
    this.connections.delete(sessionId);
    if (!player) return;
    player.connected = false;
    player.vx = 0;
    player.vz = 0;
    player.disconnectedAt = Date.now();
    player.lastUpdate = Date.now();
    this.markDirty();
    await this.flushState(true);
    if (this.connections.size === 0) {
      this.stopLoops();
    }
  }

  ensureLoops() {
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => {
        void this.tick();
      }, TICK_INTERVAL);
    }
    if (!this.broadcastTimer) {
      this.broadcastTimer = setInterval(() => {
        this.broadcastState();
      }, BROADCAST_INTERVAL);
    }
  }

  stopLoops() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  getConnectedAlivePlayers() {
    return [...this.players.values()].filter((player) => player.connected && player.alive);
  }

  spawnStarNearPlayers(players) {
    const star = generateStar();
    if (players.length > 0) {
      const p = players[Math.floor(Math.random() * players.length)];
      const angle = Math.random() * Math.PI * 2;
      const dist = rand(STAR_SPAWN_RADIUS_MIN, STAR_SPAWN_RADIUS_MAX);
      star.x = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, p.x + Math.cos(angle) * dist));
      star.z = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, p.z + Math.sin(angle) * dist));
    }
    return star;
  }

  cleanupDisconnectedPlayers(now) {
    let changed = false;
    for (const [playerSessionId, player] of this.players) {
      if (player.connected || player.disconnectedAt == null) continue;
      if (now - player.disconnectedAt < RECONNECT_GRACE_MS) continue;
      this.players.delete(playerSessionId);
      changed = true;
    }
    if (changed) {
      this.markDirty();
    }
  }

  async tick() {
    await this.ready;
    this.tickCount++;
    const now = Date.now();
    const dt = TICK_INTERVAL / 1000;
    this.cleanupDisconnectedPlayers(now);

    if (now >= this.nextReset) {
      await this.performDailyReset();
      return;
    }

    const activePlayers = this.getConnectedAlivePlayers();
    for (const player of activePlayers) {
      player.x += player.vx * dt;
      player.z += player.vz * dt;
      player.x = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, player.x));
      player.z = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, player.z));
      player.lastUpdate = now;
    }

    for (let left = 0; left < activePlayers.length; left++) {
      for (let right = left + 1; right < activePlayers.length; right++) {
        const first = activePlayers[left];
        const second = activePlayers[right];
        const dx = first.x - second.x;
        const dz = first.z - second.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const firstRadius = 4 + Math.pow(first.mass, 0.48) * 0.85;
        const secondRadius = 4 + Math.pow(second.mass, 0.48) * 0.85;
        const swallowDistance = Math.max(firstRadius, secondRadius) * 1.2;

        if (distance >= swallowDistance) continue;

        let winner = null;
        let loser = null;
        if (first.mass >= second.mass * SWALLOW_RATIO) {
          winner = first;
          loser = second;
        } else if (second.mass >= first.mass * SWALLOW_RATIO) {
          winner = second;
          loser = first;
        }

        if (!winner || !loser) continue;

        winner.mass += loser.mass * 0.8;
        winner.eaten += 1;
        loser.alive = false;
        loser.mass = INITIAL_MASS;
        loser.vx = 0;
        loser.vz = 0;
        loser.lastUpdate = now;
        this.markDirty();

        this.sendToSession(loser.sessionId, {
          type: "killed",
          by: winner.name,
          killerMass: winner.mass,
        });

        this.broadcast({
          type: "player_killed",
          killerId: winner.id,
          killerName: winner.name,
          victimId: loser.id,
          victimName: loser.name,
        });
      }
    }

    // 在线玩家 vs 离线存活玩家的碰撞检测
    const offlineAlivePlayers = [...this.players.values()].filter((p) => !p.connected && p.alive);
    for (const active of activePlayers) {
      if (!active.alive) continue;
      for (const offline of offlineAlivePlayers) {
        const dx = active.x - offline.x;
        const dz = active.z - offline.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const activeRadius = 4 + Math.pow(active.mass, 0.48) * 0.85;
        const offlineRadius = 4 + Math.pow(offline.mass, 0.48) * 0.85;
        const swallowDistance = Math.max(activeRadius, offlineRadius) * 1.2;

        if (distance >= swallowDistance) continue;

        let winner = null;
        let loser = null;
        if (active.mass >= offline.mass * SWALLOW_RATIO) {
          winner = active;
          loser = offline;
        } else if (offline.mass >= active.mass * SWALLOW_RATIO) {
          winner = offline;
          loser = active;
        }

        if (!winner || !loser) continue;

        winner.mass += loser.mass * 0.8;
        winner.eaten += 1;
        this.markDirty();

        this.broadcast({
          type: "player_killed",
          killerId: winner.id,
          killerName: winner.name,
          victimId: loser.id,
          victimName: loser.name,
        });

        if (loser.connected) {
          // 在线玩家被离线玩家吃掉：正常死亡流程
          loser.alive = false;
          loser.mass = INITIAL_MASS;
          loser.vx = 0;
          loser.vz = 0;
          loser.lastUpdate = now;
          this.sendToSession(loser.sessionId, {
            type: "killed",
            by: winner.name,
            killerMass: winner.mass,
          });
        } else {
          // 离线玩家被吃掉：随机位置重生，保持离线状态
          loser.x = randomInBound();
          loser.z = randomInBound();
          loser.mass = INITIAL_MASS;
          loser.vx = 0;
          loser.vz = 0;
          loser.lastUpdate = now;
        }
      }
    }

    const starCells = new Map();
    for (let index = 0; index < this.stars.length; index++) {
      const star = this.stars[index];
      const key = starCellKey(star.x, star.z);
      const bucket = starCells.get(key);
      if (bucket) {
        bucket.push(index);
      } else {
        starCells.set(key, [index]);
      }
    }

    const consumedIndices = new Set();
    for (const player of activePlayers) {
      if (!player.alive) continue;
      const horizon = (4 + Math.pow(player.mass, 0.48) * 0.85) * 1.05;
      const scanRadius = horizon + 30;
      const cellRadius = Math.max(1, Math.ceil(scanRadius / STAR_CELL_SIZE));
      const centerCellX = Math.floor(player.x / STAR_CELL_SIZE);
      const centerCellZ = Math.floor(player.z / STAR_CELL_SIZE);
      const removedStarIds = [];

      for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX++) {
        for (let offsetZ = -cellRadius; offsetZ <= cellRadius; offsetZ++) {
          const bucket = starCells.get(`${centerCellX + offsetX},${centerCellZ + offsetZ}`);
          if (!bucket) continue;
          for (const starIndex of bucket) {
            if (consumedIndices.has(starIndex)) continue;
            const star = this.stars[starIndex];
            if (!star) continue;
            const dx = player.x - star.x;
            const dz = player.z - star.z;
            const distance = Math.sqrt(dx * dx + dz * dz);
            if (distance >= scanRadius) continue;
            const gain = star.mass * (star.type === "star" ? 1.0 : star.type === "planet" ? 0.88 : 0.68);
            player.mass += gain;
            player.eaten += 1;
            consumedIndices.add(starIndex);
            removedStarIds.push(star.id);
            this.markDirty();
          }
        }
      }

      if (removedStarIds.length > 0) {
        this.broadcast({ type: "stars_remove", starIds: removedStarIds });
      }
    }

    if (consumedIndices.size > 0) {
      this.stars = this.stars.filter((_, index) => !consumedIndices.has(index));
    }

    // 周期性回收远离所有玩家的星体，为附近补充腾出空间
    if (activePlayers.length > 0 && this.tickCount % STAR_RECYCLE_INTERVAL === 0) {
      const rr2 = STAR_RECYCLE_RADIUS * STAR_RECYCLE_RADIUS;
      const toRemoveIds = [];
      this.stars = this.stars.filter((star) => {
        for (const p of activePlayers) {
          const dx = star.x - p.x, dz = star.z - p.z;
          if (dx * dx + dz * dz < rr2) return true; // 在某玩家附近，保留
        }
        toRemoveIds.push(star.id);
        return false; // 所有玩家都很远，回收
      });
      if (toRemoveIds.length > 0) {
        this.broadcast({ type: "stars_remove", starIds: toRemoveIds });
        this.markDirty();
      }
    }

    if (this.stars.length < STAR_MAX) {
      const toSpawn = Math.min(STAR_BATCH, STAR_MAX - this.stars.length);
      const newStars = [];
      for (let index = 0; index < toSpawn; index++) {
        const star = this.spawnStarNearPlayers(activePlayers);
        this.stars.push(star);
        newStars.push(star);
      }
      if (newStars.length > 0) {
        this.markDirty();
        this.broadcast({ type: "stars_add", stars: newStars });
      }
    }

    await this.flushState();
  }

  broadcastState() {
    if (this.connections.size === 0) return;
    // 包含在线玩家 + 离线存活玩家（让其他玩家可以看到并吞噬他们）
    const players = this.getPlayersSnapshot({ connectedOnly: false });
    const ranking = this.getCurrentRanking();
    this.broadcast({
      type: "state",
      players,
      starCount: this.stars.length,
      ranking: ranking.slice(0, 20),
      lastSeason: this.seasonRanking.slice(0, 20),
      nextReset: this.nextReset,
    });
  }

  getPlayersSnapshot(options = {}) {
    const { connectedOnly = false } = options;
    const snapshot = [];
    for (const player of this.players.values()) {
      if (connectedOnly && !player.connected) continue;
      // 非 connectedOnly 时：包含在线玩家 + 离线存活玩家，跳过离线已死玩家
      if (!connectedOnly && !player.connected && !player.alive) continue;
      snapshot.push({
        id: player.id,
        name: player.name,
        x: Math.round(player.x),
        z: Math.round(player.z),
        mass: Math.round(player.mass * 10) / 10,
        eaten: player.eaten,
        alive: player.alive,
        connected: player.connected,
      });
    }
    return snapshot;
  }

  getCurrentRanking(force = false) {
    const now = Date.now();
    if (!force && now - this.cachedRankingAt < RANKING_CACHE_MS && this.cachedRanking.length > 0) {
      return this.cachedRanking;
    }

    const ranking = [];
    for (const player of this.players.values()) {
      ranking.push({
        id: player.id,
        name: player.name,
        mass: Math.round(player.mass * 10) / 10,
        eaten: player.eaten,
        alive: player.alive,
        connected: player.connected,
      });
    }
    ranking.sort((left, right) => right.mass - left.mass);
    this.cachedRanking = ranking;
    this.cachedRankingAt = now;
    return ranking;
  }

  async performDailyReset() {
    this.seasonRanking = this.getCurrentRanking(true);
    const upcomingReset = nextResetTime();
    this.broadcast({
      type: "season_end",
      ranking: this.seasonRanking,
      nextReset: upcomingReset,
    });

    for (const player of this.players.values()) {
      player.x = randomInBound();
      player.z = randomInBound();
      player.mass = INITIAL_MASS;
      player.eaten = 0;
      player.vx = 0;
      player.vz = 0;
      player.alive = true;
      player.lastUpdate = Date.now();
    }

    const preGeneratedStars = await this.consumePreGeneratedStars();
    this.stars = preGeneratedStars || createInitialStars();
    this.nextReset = upcomingReset;
    this.markDirty();
    await this.flushState(true);
    await this.scheduleNextResetAlarm();
    void this.primeNextSeasonWorld();

    for (const player of this.players.values()) {
      if (!player.connected) continue;
      this.sendToSession(player.sessionId, {
        type: "reset",
        x: player.x,
        z: player.z,
        mass: player.mass,
        stars: this.stars,
        lastSeason: this.seasonRanking.slice(0, 20),
        nextReset: this.nextReset,
      });
    }
  }

  broadcast(message, excludeSessionId) {
    const payload = JSON.stringify(message);
    for (const [currentSessionId, socket] of this.connections) {
      if (currentSessionId === excludeSessionId) continue;
      try {
        socket.send(payload);
      } catch {
        // ignore closed socket
      }
    }
  }

  sendToSession(sessionId, message) {
    const socket = this.connections.get(sessionId);
    if (!socket) return;
    this.sendToSocket(socket, message);
  }

  sendToSocket(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // ignore closed socket
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      const id = env.GAME_WORLD.idFromName("global");
      const stub = env.GAME_WORLD.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
