const WORLD_BOUND = 100000;
const TICK_INTERVAL = 50;
const STAR_MAX = 600;
const STAR_BATCH = 15;
const INITIAL_MASS = 1000;
const SWALLOW_RATIO = 1.3;
const BROADCAST_INTERVAL = 50;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const PERSIST_INTERVAL_MS = 1000;
const STORAGE_KEY = "worldState";

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

function createInitialStars() {
  const stars = [];
  for (let index = 0; index < STAR_MAX; index++) {
    stars.push(generateStar());
  }
  return stars;
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
  }

  markDirty() {
    this.dirty = true;
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

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

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
      return new Response(JSON.stringify({
        current: this.getCurrentRanking(),
        lastSeason: this.seasonRanking,
        nextReset: this.nextReset,
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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
        const requestedSessionId = normalizeSessionId(message.sessionId);
        const playerName = sanitizePlayerName(message.name);
        const { player, restored } = this.createOrRestorePlayer(requestedSessionId, playerName);
        sessionId = player.sessionId;
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
          players: this.getPlayersSnapshot({ connectedOnly: true }),
          nextReset: this.nextReset,
          worldBound: WORLD_BOUND,
          restored,
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

    for (const player of activePlayers) {
      if (!player.alive) continue;
      const horizon = (4 + Math.pow(player.mass, 0.48) * 0.85) * 1.05;
      for (let index = this.stars.length - 1; index >= 0; index--) {
        const star = this.stars[index];
        const dx = player.x - star.x;
        const dz = player.z - star.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance >= horizon + 30) continue;
        const gain = star.mass * (star.type === "star" ? 1.0 : star.type === "planet" ? 0.88 : 0.68);
        player.mass += gain;
        player.eaten += 1;
        this.stars.splice(index, 1);
        this.markDirty();
      }
    }

    if (this.stars.length < STAR_MAX) {
      const toSpawn = Math.min(STAR_BATCH, STAR_MAX - this.stars.length);
      const newStars = [];
      for (let index = 0; index < toSpawn; index++) {
        const star = generateStar();
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
    const players = this.getPlayersSnapshot({ connectedOnly: true });
    const ranking = this.getCurrentRanking();
    this.broadcast({
      type: "state",
      players,
      starCount: this.stars.length,
      ranking: ranking.slice(0, 20),
      nextReset: this.nextReset,
    });
  }

  getPlayersSnapshot(options = {}) {
    const { connectedOnly = false } = options;
    const snapshot = [];
    for (const player of this.players.values()) {
      if (connectedOnly && !player.connected) continue;
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

  getCurrentRanking() {
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
    return ranking;
  }

  async performDailyReset() {
    this.seasonRanking = this.getCurrentRanking();
    this.broadcast({
      type: "season_end",
      ranking: this.seasonRanking,
      nextReset: nextResetTime(),
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

    this.stars = createInitialStars();
    this.nextReset = nextResetTime();
    this.markDirty();
    await this.flushState(true);

    for (const player of this.players.values()) {
      if (!player.connected) continue;
      this.sendToSession(player.sessionId, {
        type: "reset",
        x: player.x,
        z: player.z,
        mass: player.mass,
        stars: this.stars,
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
