// ─── Cloudflare Worker + Durable Object: BlackHole Multiplayer ───

const WORLD_BOUND = 100000;
const TICK_INTERVAL = 50;           // 50ms server tick (~20Hz)
const STAR_SPAWN_INTERVAL = 2000;   // spawn stars every 2s
const STAR_MAX = 600;               // max stars in the world
const STAR_BATCH = 15;              // stars per spawn batch
const INITIAL_MASS = 1000;
const SWALLOW_RATIO = 1.3;          // must be 1.3x mass to swallow another player
const BROADCAST_INTERVAL = 50;      // broadcast state every 50ms

function resetHourUTC() {
  // Beijing 04:00 = UTC 20:00 (previous day)
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

function generateStar() {
  const r = Math.random();
  let type, mass, hue, sat, light;
  if (r < 0.55) {
    type = "asteroid"; mass = rand(5, 22); hue = rand(24, 45); sat = rand(45, 70); light = rand(50, 67);
  } else if (r < 0.88) {
    type = "planet"; mass = rand(22, 86); hue = rand(170, 235); sat = rand(55, 88); light = rand(56, 72);
  } else {
    type = "star"; mass = rand(86, 180); hue = rand(8, 58); sat = rand(78, 95); light = rand(68, 84);
  }
  return {
    id: crypto.randomUUID(),
    x: randomInBound(),
    z: randomInBound(),
    mass, type,
    hue: Math.round(hue),
    sat: Math.round(sat),
    light: Math.round(light),
  };
}

export class GameWorld {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map();       // id -> { ws, name, x, z, mass, eaten, vx, vz, lastUpdate, alive }
    this.stars = [];
    this.seasonRanking = [];        // last season ranking
    this.nextReset = nextResetTime();
    this.tickTimer = null;
    this.broadcastTimer = null;

    // Initialize stars
    for (let i = 0; i < STAR_MAX; i++) {
      this.stars.push(generateStar());
    }
  }

  async fetch(request) {
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

    const playerId = crypto.randomUUID();
    let playerRegistered = false;

    // Start tick if first player
    if (this.players.size === 0) {
      this.startTick();
    }

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "join") {
        const name = String(msg.name || "").slice(0, 20) || "匿名黑洞";
        const player = {
          ws,
          id: playerId,
          name,
          x: randomInBound(),
          z: randomInBound(),
          mass: INITIAL_MASS,
          eaten: 0,
          vx: 0,
          vz: 0,
          lastUpdate: Date.now(),
          alive: true,
        };
        this.players.set(playerId, player);
        playerRegistered = true;

        // Send init data
        this.sendTo(ws, {
          type: "init",
          id: playerId,
          x: player.x,
          z: player.z,
          mass: player.mass,
          stars: this.stars,
          players: this.getPlayersSnapshot(),
          nextReset: this.nextReset,
          worldBound: WORLD_BOUND,
        });

        // Broadcast new player
        this.broadcast({
          type: "player_join",
          id: playerId,
          name,
          x: player.x,
          z: player.z,
          mass: player.mass,
        }, playerId);

        return;
      }

      if (!playerRegistered) return;
      const player = this.players.get(playerId);
      if (!player || !player.alive) return;

      if (msg.type === "move") {
        // Client sends velocity; server validates and applies
        const vx = clampNum(msg.vx, -400, 400);
        const vz = clampNum(msg.vz, -400, 400);
        player.vx = vx;
        player.vz = vz;
        player.lastUpdate = Date.now();
      }

      if (msg.type === "respawn") {
        player.x = randomInBound();
        player.z = randomInBound();
        player.mass = INITIAL_MASS;
        player.eaten = 0;
        player.vx = 0;
        player.vz = 0;
        player.alive = true;
        this.sendTo(ws, {
          type: "respawn",
          x: player.x,
          z: player.z,
          mass: player.mass,
        });
      }
    });

    ws.addEventListener("close", () => {
      this.players.delete(playerId);
      this.broadcast({ type: "player_leave", id: playerId });
      if (this.players.size === 0) {
        this.stopTick();
      }
    });

    ws.addEventListener("error", () => {
      this.players.delete(playerId);
      this.broadcast({ type: "player_leave", id: playerId });
      if (this.players.size === 0) {
        this.stopTick();
      }
    });
  }

  startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL);
    this.broadcastTimer = setInterval(() => this.broadcastState(), BROADCAST_INTERVAL);
  }

  stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  tick() {
    const now = Date.now();
    const dt = TICK_INTERVAL / 1000;

    // Check daily reset
    if (now >= this.nextReset) {
      this.performDailyReset();
      return;
    }

    // Update player positions
    for (const [id, p] of this.players) {
      if (!p.alive) continue;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      // Clamp to world bounds
      p.x = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, p.x));
      p.z = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, p.z));
    }

    // PvP swallowing
    const alivePlayers = [...this.players.values()].filter(p => p.alive);
    for (let i = 0; i < alivePlayers.length; i++) {
      for (let j = i + 1; j < alivePlayers.length; j++) {
        const a = alivePlayers[i];
        const b = alivePlayers[j];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const aRadius = 4 + Math.pow(a.mass, 0.48) * 0.85;
        const bRadius = 4 + Math.pow(b.mass, 0.48) * 0.85;
        const swallowDist = Math.max(aRadius, bRadius) * 1.2;

        if (dist < swallowDist) {
          let winner, loser;
          if (a.mass >= b.mass * SWALLOW_RATIO) {
            winner = a; loser = b;
          } else if (b.mass >= a.mass * SWALLOW_RATIO) {
            winner = b; loser = a;
          } else {
            continue; // too close in mass, no swallow
          }

          winner.mass += loser.mass * 0.8;
          winner.eaten++;
          loser.alive = false;
          loser.mass = INITIAL_MASS;

          // Notify loser
          this.sendTo(loser.ws, {
            type: "killed",
            by: winner.name,
            killerMass: winner.mass,
          });

          // Broadcast kill
          this.broadcast({
            type: "player_killed",
            killerId: winner.id,
            killerName: winner.name,
            victimId: loser.id,
            victimName: loser.name,
          });
        }
      }
    }

    // Star eating
    for (const [id, p] of this.players) {
      if (!p.alive) continue;
      const horizon = (4 + Math.pow(p.mass, 0.48) * 0.85) * 1.05;
      for (let i = this.stars.length - 1; i >= 0; i--) {
        const s = this.stars[i];
        const dx = p.x - s.x;
        const dz = p.z - s.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < horizon + 30) {
          const gain = s.mass * (s.type === "star" ? 1.0 : s.type === "planet" ? 0.88 : 0.68);
          p.mass += gain;
          p.eaten++;
          this.stars.splice(i, 1);
        }
      }
    }

    // Spawn new stars
    if (this.stars.length < STAR_MAX) {
      const toSpawn = Math.min(STAR_BATCH, STAR_MAX - this.stars.length);
      const newStars = [];
      for (let i = 0; i < toSpawn; i++) {
        const star = generateStar();
        this.stars.push(star);
        newStars.push(star);
      }
      if (newStars.length > 0) {
        this.broadcast({ type: "stars_add", stars: newStars });
      }
    }
  }

  broadcastState() {
    const playersData = [];
    for (const [id, p] of this.players) {
      playersData.push({
        id, name: p.name,
        x: Math.round(p.x),
        z: Math.round(p.z),
        mass: Math.round(p.mass * 10) / 10,
        eaten: p.eaten,
        alive: p.alive,
      });
    }

    const ranking = this.getCurrentRanking();

    this.broadcast({
      type: "state",
      players: playersData,
      starCount: this.stars.length,
      ranking: ranking.slice(0, 20),
      nextReset: this.nextReset,
    });
  }

  getCurrentRanking() {
    const ranking = [];
    for (const [id, p] of this.players) {
      ranking.push({ id, name: p.name, mass: Math.round(p.mass * 10) / 10, eaten: p.eaten, alive: p.alive });
    }
    ranking.sort((a, b) => b.mass - a.mass);
    return ranking;
  }

  performDailyReset() {
    // Save final ranking
    this.seasonRanking = this.getCurrentRanking();

    // Broadcast season end
    this.broadcast({
      type: "season_end",
      ranking: this.seasonRanking,
      nextReset: nextResetTime(),
    });

    // Reset all players
    for (const [id, p] of this.players) {
      p.x = randomInBound();
      p.z = randomInBound();
      p.mass = INITIAL_MASS;
      p.eaten = 0;
      p.vx = 0;
      p.vz = 0;
      p.alive = true;
    }

    // Reset stars
    this.stars = [];
    for (let i = 0; i < STAR_MAX; i++) {
      this.stars.push(generateStar());
    }

    this.nextReset = nextResetTime();

    // Send new state to all
    for (const [id, p] of this.players) {
      this.sendTo(p.ws, {
        type: "reset",
        x: p.x,
        z: p.z,
        mass: p.mass,
        stars: this.stars,
        nextReset: this.nextReset,
      });
    }
  }

  getPlayersSnapshot() {
    const result = [];
    for (const [id, p] of this.players) {
      result.push({
        id, name: p.name,
        x: Math.round(p.x),
        z: Math.round(p.z),
        mass: Math.round(p.mass * 10) / 10,
        eaten: p.eaten,
        alive: p.alive,
      });
    }
    return result;
  }

  broadcast(msg, excludeId) {
    const data = JSON.stringify(msg);
    for (const [id, p] of this.players) {
      if (id === excludeId) continue;
      try { p.ws.send(data); } catch { /* ignore closed sockets */ }
    }
  }

  sendTo(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      const id = env.GAME_WORLD.idFromName("global");
      const stub = env.GAME_WORLD.get(id);
      return stub.fetch(request);
    }

    // Serve static assets from the assets binding
    return env.ASSETS.fetch(request);
  },
};
