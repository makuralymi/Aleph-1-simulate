// ─── multiplayer.js: WebSocket 联机层 ───
// 不修改原始游戏逻辑，仅负责网络同步与 UI 交互

(function () {
  "use strict";

  const welcomeOverlay = document.getElementById("welcomeOverlay");
  const nicknameInput = document.getElementById("nicknameInput");
  const startGameBtn = document.getElementById("startGameBtn");
  const deathOverlay = document.getElementById("deathOverlay");
  const deathInfo = document.getElementById("deathInfo");
  const respawnBtn = document.getElementById("respawnBtn");
  const seasonOverlay = document.getElementById("seasonOverlay");
  const seasonRanking = document.getElementById("seasonRanking");
  const seasonCloseBtn = document.getElementById("seasonCloseBtn");
  const leaderboardToggle = document.getElementById("leaderboardToggle");
  const leaderboardBody = document.getElementById("leaderboardBody");
  const leaderboardArrow = document.getElementById("leaderboardArrow");
  const leaderboardTbody = document.getElementById("leaderboardTbody");
  const onlineCountEl = document.getElementById("onlineCount");
  const resetTimerEl = document.getElementById("resetTimer");
  const killFeed = document.getElementById("killFeed");
  const SESSION_STORAGE_KEY = "blackhole-multiplayer-session-id";
  const NAME_STORAGE_KEY = "blackhole-multiplayer-name";

  let ws = null;
  let connected = false;
  let nextResetTime = 0;
  let leaderboardCollapsed = false;
  let sendInterval = null;
  let reconnectTimer = null;

  // ── 排行榜折叠 ──
  leaderboardToggle.addEventListener("click", () => {
    leaderboardCollapsed = !leaderboardCollapsed;
    leaderboardBody.style.display = leaderboardCollapsed ? "none" : "block";
    leaderboardArrow.textContent = leaderboardCollapsed ? "▶" : "▼";
  });

  // ── 重置倒计时 ──
  function updateResetTimer() {
    if (!nextResetTime) { resetTimerEl.textContent = "--:--:--"; return; }
    const diff = Math.max(0, nextResetTime - Date.now());
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    resetTimerEl.textContent =
      String(h).padStart(2, "0") + ":" +
      String(m).padStart(2, "0") + ":" +
      String(s).padStart(2, "0");
  }
  setInterval(updateResetTimer, 1000);

  // ── 击杀通知 ──
  function addKillNotice(killer, victim) {
    const el = document.createElement("div");
    el.className = "kill-notice";
    el.textContent = killer + " 吞噬了 " + victim;
    killFeed.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 500);
    }, 4000);
    // 限制最多显示5条
    while (killFeed.children.length > 5) {
      killFeed.removeChild(killFeed.firstChild);
    }
  }

  // ── 排行榜更新 ──
  function updateLeaderboard(ranking) {
    leaderboardTbody.innerHTML = "";
    for (let i = 0; i < Math.min(ranking.length, 20); i++) {
      const r = ranking[i];
      const tr = document.createElement("tr");
      if (r.id === myPlayerId) tr.className = "lb-self";
      if (!r.alive) tr.className += " lb-dead";
      tr.innerHTML =
        "<td>" + (i + 1) + "</td>" +
        "<td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + Math.round(r.mass) + "</td>" +
        "<td>" + r.eaten + "</td>";
      leaderboardTbody.appendChild(tr);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ── 赛季结算展示 ──
  function showSeasonEnd(ranking) {
    seasonRanking.innerHTML = "";
    for (let i = 0; i < Math.min(ranking.length, 10); i++) {
      const r = ranking[i];
      const div = document.createElement("div");
      div.className = "season-rank-item";
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".";
      div.innerHTML = medal + " <strong>" + escapeHtml(r.name) + "</strong> — 质量 " + Math.round(r.mass) + " / 吞噬 " + r.eaten;
      seasonRanking.appendChild(div);
    }
    seasonOverlay.style.display = "flex";
  }

  seasonCloseBtn.addEventListener("click", () => {
    seasonOverlay.style.display = "none";
  });

  // ── WebSocket 连接 ──
  function connectWS(playerName) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/ws";
    const savedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      connected = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws.send(JSON.stringify({ type: "join", name: playerName, sessionId: savedSessionId }));

      // 定期发送移动信息
      sendInterval = setInterval(() => {
        if (!connected || !multiplayerStarted) return;
        ws.send(JSON.stringify({
          type: "move",
          vx: blackHole.vx,
          vz: blackHole.vz,
        }));
      }, 50);
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case "init":
          myPlayerId = msg.id;
          if (msg.sessionId) {
            window.localStorage.setItem(SESSION_STORAGE_KEY, msg.sessionId);
          }
          window.localStorage.setItem(NAME_STORAGE_KEY, playerName);
          blackHole.x = msg.x;
          blackHole.z = msg.z;
          blackHole.mass = msg.mass;
          blackHole.eaten = msg.eaten || 0;
          nextResetTime = msg.nextReset;

          // Load server stars into local star array
          stars.length = 0;
          if (msg.stars) {
            for (const s of msg.stars) {
              stars.push(serverStarToLocal(s));
            }
          }

          // Load other players
          if (msg.players) {
            for (const p of msg.players) {
              if (p.id !== myPlayerId) {
                otherPlayers.set(p.id, p);
              }
            }
          }

          if (!multiplayerStarted) {
            startGameDeferred(null);
          } else {
            resetCameraView();
            updateHud();
          }
          break;

        case "state":
          if (msg.players) {
            const serverIds = new Set();
            for (const p of msg.players) {
              serverIds.add(p.id);
              if (p.id === myPlayerId) {
                // Reconcile my own position from server (authoritative)
                blackHole.x = p.x;
                blackHole.z = p.z;
                blackHole.mass = p.mass;
                blackHole.eaten = p.eaten;
              } else {
                otherPlayers.set(p.id, p);
              }
            }
            // Remove players no longer on server
            for (const id of otherPlayers.keys()) {
              if (!serverIds.has(id)) otherPlayers.delete(id);
            }
            onlineCountEl.textContent = msg.players.length;
          }
          if (msg.ranking) updateLeaderboard(msg.ranking);
          if (msg.nextReset) nextResetTime = msg.nextReset;
          break;

        case "stars_add":
          if (msg.stars) {
            for (const s of msg.stars) {
              stars.push(serverStarToLocal(s));
            }
          }
          break;

        case "player_join":
        case "player_return":
          if (msg.id !== myPlayerId) {
            otherPlayers.set(msg.id, {
              id: msg.id, name: msg.name,
              x: msg.x, z: msg.z,
              mass: msg.mass, eaten: 0, alive: true,
            });
          }
          break;

        case "player_leave":
          otherPlayers.delete(msg.id);
          break;

        case "player_killed":
          addKillNotice(msg.killerName, msg.victimName);
          break;

        case "killed":
          deathInfo.textContent = "你被 " + msg.by + " (质量 " + Math.round(msg.killerMass) + ") 吞噬了！";
          deathOverlay.style.display = "flex";
          break;

        case "respawn":
          blackHole.x = msg.x;
          blackHole.z = msg.z;
          blackHole.mass = msg.mass;
          blackHole.eaten = 0;
          blackHole.vx = 0;
          blackHole.vz = 0;
          deathOverlay.style.display = "none";
          resetCameraView();
          break;

        case "season_end":
          showSeasonEnd(msg.ranking);
          nextResetTime = msg.nextReset;
          break;

        case "reset":
          blackHole.x = msg.x;
          blackHole.z = msg.z;
          blackHole.mass = msg.mass;
          blackHole.eaten = 0;
          blackHole.vx = 0;
          blackHole.vz = 0;
          stars.length = 0;
          if (msg.stars) {
            for (const s of msg.stars) {
              stars.push(serverStarToLocal(s));
            }
          }
          nextResetTime = msg.nextReset;
          resetCameraView();
          break;
      }
    });

    ws.addEventListener("close", () => {
      connected = false;
      if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
      reconnectTimer = setTimeout(() => {
        if (!connected) connectWS(playerName);
      }, 3000);
    });

    ws.addEventListener("error", () => {
      // will trigger close
    });
  }

  // ── 将服务器星体数据转换为本地格式 ──
  function serverStarToLocal(s) {
    const density = s.type === "asteroid" ? 3.0 : s.type === "planet" ? 1.7 : 0.4;
    const radius = Math.cbrt((3 * s.mass) / (4 * Math.PI * density));
    return {
      x: s.x,
      y: blackHole.y + (Math.random() - 0.5) * 180,
      z: s.z,
      vx: (Math.random() - 0.5) * 16,
      vy: (Math.random() - 0.5) * 8,
      vz: (Math.random() - 0.5) * 16,
      mass: s.mass,
      density: density,
      radius: radius,
      type: s.type,
      hue: s.hue,
      sat: s.sat,
      light: s.light,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 1.4,
      chunkKey: "server",
    };
  }

  // ── 重生按钮 ──
  respawnBtn.addEventListener("click", () => {
    if (ws && connected) {
      ws.send(JSON.stringify({ type: "respawn" }));
    }
  });

  // ── 重新开始回调（供 script.js 调用）──
  window.onGameRestart = function () {
    if (ws && connected) {
      ws.send(JSON.stringify({ type: "respawn" }));
    }
  };

  // ── 开始游戏 ──
  startGameBtn.addEventListener("click", startGame);
  nicknameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startGame();
  });

  function startGame() {
    const name = nicknameInput.value.trim().slice(0, 20) || "匿名黑洞";
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
    welcomeOverlay.style.display = "none";
    connectWS(name);
  }

  // 自动聚焦昵称输入框，若本地已有身份则直接尝试恢复
  const storedName = window.localStorage.getItem(NAME_STORAGE_KEY);
  const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (storedName) {
    nicknameInput.value = storedName;
  }
  if (storedName && storedSessionId) {
    welcomeOverlay.style.display = "none";
    connectWS(storedName);
  } else {
    nicknameInput.focus();
  }
})();
