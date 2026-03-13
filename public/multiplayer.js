// ─── multiplayer.js: WebSocket 联机层 ───
// 不修改原始游戏逻辑，仅负责网络同步与 UI 交互

(function () {
  "use strict";

  const welcomeOverlay = document.getElementById("welcomeOverlay");
  const accountInput = document.getElementById("accountInput");
  const passwordInput = document.getElementById("passwordInput");
  const nicknameInput = document.getElementById("nicknameInput");
  const welcomeError = document.getElementById("welcomeError");
  const loginBtn = document.getElementById("loginBtn");
  const registerBtn = document.getElementById("registerBtn");
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
  const yesterdayLeaderboardTbody = document.getElementById("yesterdayLeaderboardTbody");
  const onlineCountEl = document.getElementById("onlineCount");
  const resetTimerEl = document.getElementById("resetTimer");
  const killFeed = document.getElementById("killFeed");
  const hudToggle = document.getElementById("hudToggle");
  const hudBody = document.getElementById("hudBody");
  const hudArrow = document.getElementById("hudArrow");
  const SESSION_STORAGE_KEY = "blackhole-multiplayer-session-id";
  const NAME_STORAGE_KEY = "blackhole-multiplayer-name";
  const ACCOUNT_STORAGE_KEY = "blackhole-account-name";
  const AUTH_TOKEN_STORAGE_KEY = "blackhole-auth-token";
  const HUD_COLLAPSED_KEY = "blackhole-hud-collapsed";

  let ws = null;
  let connected = false;
  let nextResetTime = 0;
  let leaderboardCollapsed = false;
  let hudCollapsed = false;
  let sendInterval = null;
  let reconnectTimer = null;
  let authToken = null;
  let currentPlayerName = "匿名黑洞";

  function setWelcomeError(message) {
    if (!welcomeError) return;
    if (!message) {
      welcomeError.style.display = "none";
      welcomeError.textContent = "";
      return;
    }
    welcomeError.textContent = message;
    welcomeError.style.display = "block";
  }

  function applyHudCollapsedState() {
    if (!hudBody || !hudArrow) return;
    hudBody.style.display = hudCollapsed ? "none" : "block";
    hudArrow.textContent = hudCollapsed ? "▶" : "▼";
  }

  // ── 排行榜折叠 ──
  leaderboardToggle.addEventListener("click", () => {
    leaderboardCollapsed = !leaderboardCollapsed;
    leaderboardBody.style.display = leaderboardCollapsed ? "none" : "block";
    leaderboardArrow.textContent = leaderboardCollapsed ? "▶" : "▼";
  });

  if (hudToggle) {
    const savedHudCollapsed = window.localStorage.getItem(HUD_COLLAPSED_KEY);
    hudCollapsed = savedHudCollapsed === "1";
    applyHudCollapsedState();
    hudToggle.addEventListener("click", () => {
      hudCollapsed = !hudCollapsed;
      applyHudCollapsedState();
      window.localStorage.setItem(HUD_COLLAPSED_KEY, hudCollapsed ? "1" : "0");
    });
  }

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

  function updateYesterdayLeaderboard(ranking) {
    if (!yesterdayLeaderboardTbody) return;
    yesterdayLeaderboardTbody.innerHTML = "";
    const list = Array.isArray(ranking) ? ranking : [];
    for (let i = 0; i < Math.min(list.length, 10); i++) {
      const r = list[i];
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + (i + 1) + "</td>" +
        "<td>" + escapeHtml(r.name || "匿名") + "</td>" +
        "<td>" + Math.round(Number(r.mass) || 0) + "</td>" +
        "<td>" + (Number(r.eaten) || 0) + "</td>";
      yesterdayLeaderboardTbody.appendChild(tr);
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

  function clearAuthState() {
    authToken = null;
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  async function authRequest(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data?.ok) {
      const errorMessage = data?.error || "请求失败，请稍后再试";
      throw new Error(errorMessage);
    }
    return data;
  }

  // ── WebSocket 连接 ──
  function connectWS(playerName, token) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/ws";
    const savedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    ws = new WebSocket(url);
    currentPlayerName = playerName;
    authToken = token;

    ws.addEventListener("open", () => {
      connected = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws.send(JSON.stringify({ type: "join", name: playerName, token, sessionId: savedSessionId }));

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
          welcomeOverlay.style.display = "none";
          setWelcomeError("");
          window.localStorage.setItem(NAME_STORAGE_KEY, playerName);
          blackHole.x = msg.x;
          blackHole.z = msg.z;
          blackHole.mass = msg.mass;
          blackHole.eaten = msg.eaten || 0;
          nextResetTime = msg.nextReset;
          if (msg.ranking) updateLeaderboard(msg.ranking);
          if (msg.lastSeason) updateYesterdayLeaderboard(msg.lastSeason);

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

        case "auth_required":
          clearAuthState();
          if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
          connected = false;
          welcomeOverlay.style.display = "flex";
          setWelcomeError(msg.reason || "登录状态失效，请重新登录");
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
          if (msg.lastSeason) updateYesterdayLeaderboard(msg.lastSeason);
          if (msg.nextReset) nextResetTime = msg.nextReset;
          break;

        case "stars_add":
          if (msg.stars) {
            for (const s of msg.stars) {
              stars.push(serverStarToLocal(s));
            }
          }
          break;

        case "stars_remove":
          if (Array.isArray(msg.starIds) && msg.starIds.length > 0) {
            const removed = new Set(msg.starIds);
            for (let index = stars.length - 1; index >= 0; index--) {
              if (removed.has(stars[index].id)) {
                stars.splice(index, 1);
              }
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
          updateYesterdayLeaderboard(msg.ranking);
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
          if (msg.lastSeason) updateYesterdayLeaderboard(msg.lastSeason);
          nextResetTime = msg.nextReset;
          resetCameraView();
          break;
      }
    });

    ws.addEventListener("close", () => {
      connected = false;
      if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
      if (!authToken) return;
      reconnectTimer = setTimeout(() => {
        if (!connected) connectWS(currentPlayerName, authToken);
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
      id: s.id,
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

  // ── 吞噬星体回调（供 script.js 调用）──
  window.onStarEaten = function (starId, mass, type) {
    if (ws && connected && starId) {
      ws.send(JSON.stringify({ type: "eat_star", starId, mass, starType: type }));
    }
  };

  // ── 重新开始回调（供 script.js 调用）──
  window.onGameRestart = function () {
    if (ws && connected) {
      ws.send(JSON.stringify({ type: "respawn" }));
    }
  };

  // ── 开始游戏 ──
  loginBtn.addEventListener("click", () => {
    void submitAuth("login");
  });
  registerBtn.addEventListener("click", () => {
    void submitAuth("register");
  });

  function setAuthSubmitting(submitting) {
    loginBtn.disabled = submitting;
    registerBtn.disabled = submitting;
  }

  async function submitAuth(mode) {
    const username = accountInput.value.trim();
    const password = passwordInput.value;
    const nickname = nicknameInput.value.trim().slice(0, 20);

    if (!username) {
      setWelcomeError("请输入账号");
      accountInput.focus();
      return;
    }
    if (!password) {
      setWelcomeError("请输入密码");
      passwordInput.focus();
      return;
    }

    setAuthSubmitting(true);
    setWelcomeError("");
    try {
      const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload = mode === "register"
        ? { username, password, nickname: nickname || username }
        : { username, password };
      const result = await authRequest(path, payload);
      const playerName = (nickname || result.nickname || result.username || username).slice(0, 20) || "匿名黑洞";
      authToken = result.token;
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, result.token);
      window.localStorage.setItem(ACCOUNT_STORAGE_KEY, username);
      window.localStorage.setItem(NAME_STORAGE_KEY, playerName);
      connectWS(playerName, result.token);
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败，请稍后再试";
      setWelcomeError(message);
    } finally {
      setAuthSubmitting(false);
    }
  }

  // 自动聚焦昵称输入框，若本地已有身份则直接尝试恢复
  const storedToken = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  const storedAccount = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
  const storedName = window.localStorage.getItem(NAME_STORAGE_KEY);
  const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (storedAccount) {
    accountInput.value = storedAccount;
  }
  if (storedName) {
    nicknameInput.value = storedName;
  }
  if (storedToken && storedName && storedSessionId) {
    welcomeOverlay.style.display = "none";
    connectWS(storedName, storedToken);
  } else {
    accountInput.focus();
  }

  passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      void submitAuth("login");
    }
  });
})();
