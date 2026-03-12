//  DOM 
const canvas     = document.getElementById("game");
const ctx        = canvas.getContext("2d");
const massEl     = document.getElementById("massValue");
const eatEl      = document.getElementById("eatCount");
const speedEl    = document.getElementById("speedValue");
const sectorEl   = document.getElementById("sectorValue");
const targetMassEl = document.getElementById("targetMassValue");
const posEl      = document.getElementById("posValue");
const goalStatusEl = document.getElementById("goalStatus");
const restartBtnEl = document.getElementById("restartButton");

const SAVE_STORAGE_KEY = "fleet-snowfluff-blackhole-save-v1";

// ── 多人联机：其他玩家数据 ──
const otherPlayers = new Map();  // id -> { name, x, z, mass, eaten, alive }
let myPlayerId = null;
let multiplayerStarted = false;
const SAVE_INTERVAL_MS = 1200;
const CAMERA_PITCH_MIN = 0.2;
const CAMERA_PITCH_MAX = Math.PI - 0.2;
const CAMERA_DISTANCE_MIN = 320;
const CAMERA_DISTANCE_MAX = 1800;
const CAMERA_DEFAULT_DISTANCE = 800;
const CAMERA_DEFAULT_YAW = 0;
const CAMERA_DEFAULT_PITCH = Math.PI / 2;

//  贴图 
const imgBH  = new Image(); imgBH.src  = "bh.png";
const imgAMS = new Image(); imgAMS.src = "ams.png";

//  键盘 
const keys = new Set();

//  常量 
const SIM = {
  G:                 140,    // 引力常数（适度加大让轨道更明显）
  softening:         30,     // 软化长度（将被平方使用）
  focus:             720,
  drag:              0.982,
  chunkSize:         1700,
  activeChunkRadius: 2,
  starsPerChunkBase: 14,
  maxSpeed:          400,
};

const SECTORS = [
  { name: "欧尔特边缘",  targetMass: 1500,  gBoost: 0,  bodyScale: 1.0  },
  { name: "苍蓝星桥",   targetMass: 2600,  gBoost: 15, bodyScale: 1.15 },
  { name: "天鹅臂裂隙", targetMass: 4200,  gBoost: 34, bodyScale: 1.28 },
  { name: "红巨核环",   targetMass: 6500,  gBoost: 58, bodyScale: 1.42 },
  { name: "视界圣堂",   targetMass: 9800,  gBoost: 84, bodyScale: 1.60 },
];

//  鼠标状态
const mousePos = { x: 0, y: 0 };
let   mouseDown = false;
let   viewDragging = false;
let   viewDragLastX = 0;
let   viewDragLastY = 0;

//  相机（围绕黑洞中心的轨道视角）
const camera = { x: 0, y: 800, z: 120, yaw: CAMERA_DEFAULT_YAW, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE };

//  黑洞 
const blackHole = { x: 0, y: 0, z: 120, vx: 0, vy: 0, vz: 0, mass: 1000, eaten: 0 };
let   bhSpinAngle = 0;
const diskParticles = [];
const diskBands = [];

//  世界状态 
const stars = [];
const activeChunks = new Set();
const deepStars = [];
const absorptionFlashes = [];
let   unlockedSectorIndex = 0;
let   gameWon  = false;
let   lastEatMass = 0;
let   lastSavedAt = 0;

let width = 0, height = 0;
let lastTime = performance.now();

// 
//  工具
// 
function rand(min, max) { return Math.random() * (max - min) + min; }

function clampValue(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function randomDirection3D() {
  const z = rand(-1, 1);
  const theta = rand(0, Math.PI * 2);
  const radius = Math.sqrt(1 - z * z);
  return {
    x: radius * Math.cos(theta),
    y: radius * Math.sin(theta),
    z,
  };
}

function updateCameraOrbitPosition() {
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const sinYaw = Math.sin(camera.yaw);
  const cosYaw = Math.cos(camera.yaw);
  const forwardX = cosPitch * sinYaw;
  const forwardY = -sinPitch;
  const forwardZ = cosPitch * cosYaw;
  camera.x = blackHole.x - forwardX * camera.distance;
  camera.y = blackHole.y - forwardY * camera.distance;
  camera.z = blackHole.z - forwardZ * camera.distance;
}

function resetCameraView() {
  camera.yaw = CAMERA_DEFAULT_YAW;
  camera.pitch = CAMERA_DEFAULT_PITCH;
  camera.distance = CAMERA_DEFAULT_DISTANCE;
  updateCameraOrbitPosition();
}

function finiteOr(fallback, value) {
  return Number.isFinite(value) ? value : fallback;
}

function readSavedGame() {
  try {
    const raw = window.localStorage.getItem(SAVE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function saveGame(force = false) {
  const now = Date.now();
  if (!force && now - lastSavedAt < SAVE_INTERVAL_MS) {
    return;
  }
  try {
    window.localStorage.setItem(SAVE_STORAGE_KEY, JSON.stringify({
      version: 1,
      blackHole: {
        x: blackHole.x,
        y: blackHole.y,
        z: blackHole.z,
        vx: blackHole.vx,
        vy: blackHole.vy,
        vz: blackHole.vz,
        mass: blackHole.mass,
        eaten: blackHole.eaten,
      },
      camera: {
        yaw: camera.yaw,
        pitch: camera.pitch,
        distance: camera.distance,
      },
      unlockedSectorIndex,
      gameWon,
      lastEatMass,
      savedAt: now,
    }));
    lastSavedAt = now;
  } catch (error) {
    // ignore storage errors
  }
}

function clearSavedGame() {
  try {
    window.localStorage.removeItem(SAVE_STORAGE_KEY);
  } catch (error) {
    // ignore storage errors
  }
}

// 半径公式：指数揘高为0.48，使质量从1000ℹ9800时半径增长约3倍
function bhRadius()     { return 4 + Math.pow(blackHole.mass, 0.48) * 0.85; }
function eventHorizon() { return bhRadius() * 1.05; }
function tidalRadius()  { return bhRadius() * 3.8; }

//  脏吐脉冲（吸收时膨胀，大小正比于被吸质量）
let bhScalePulse = 1.0;

function resize() {
  width  = window.innerWidth;
  height = window.innerHeight;
  canvas.width  = width  * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width  = width  + "px";
  canvas.style.height = height + "px";
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

//  完整 3D 旋转投影（yaw + pitch 相机矩阵）
function project(wx, wy, wz) {
  let dx = wx - camera.x;
  let dy = wy - camera.y;
  let dz = wz - camera.z;

  // yaw（绕 Y 轴）
  const cy = Math.cos(-camera.yaw), sy = Math.sin(-camera.yaw);
  let rx =  dx * cy + dz * sy;
  let ry =  dy;
  let rz = -dx * sy + dz * cy;

  // pitch（绕 X 轴）
  const cp = Math.cos(-camera.pitch), sp = Math.sin(-camera.pitch);
  let fx =  rx;
  let fy =  ry * cp - rz * sp;
  let fz =  ry * sp + rz * cp;

  if (fz < 12) return null;
  const scale = SIM.focus / fz;
  return { x: width * 0.5 + fx * scale, y: height * 0.5 + fy * scale, scale, fz };
}

// 
//  星区 / 天体生成
// 
function getCurrentSectorIndex() { return Math.min(unlockedSectorIndex, SECTORS.length - 1); }
function currentSector()         { return SECTORS[getCurrentSectorIndex()]; }
function gravitationalConstant() { return SIM.G + currentSector().gBoost; }

function bodyTemplate() {
  const r = Math.random();
  if (r < 0.55) return { type:"asteroid", massMin:5,  massMax:22,  density:rand(2.2,4.1), hueBase:rand(24,45),   sat:rand(45,70), light:rand(50,67) };
  if (r < 0.88) return { type:"planet",   massMin:22, massMax:86,  density:rand(1.1,2.3), hueBase:rand(170,235), sat:rand(55,88), light:rand(56,72) };
  return             { type:"star",     massMin:86, massMax:180, density:rand(0.2,0.55),hueBase:rand(8,58),    sat:rand(78,95), light:rand(68,84) };
}

function calcBodyRadius(mass, density) { return Math.cbrt((3 * mass) / (4 * Math.PI * density)); }

// cx/cz 是 X-Z 平面上的区块坐标（WASD 移动面），y 轴是世界上下方向
function spawnBodyInChunk(cx, cz) {
  const sector = currentSector();
  // 星体在 X-Z 水平面散布，Y 仅有小幅随机偏移使星盘有薄厚感
  const x = cx * SIM.chunkSize + rand(-SIM.chunkSize * 0.45, SIM.chunkSize * 0.45);
  const z = cz * SIM.chunkSize + rand(-SIM.chunkSize * 0.45, SIM.chunkSize * 0.45);
  const y = blackHole.y + rand(-90, 90);

  const dx = x - blackHole.x, dy = y - blackHole.y, dz = z - blackHole.z;
  const dist = Math.hypot(dx, dy, dz);

  // 圆轨道速度：绕 Y 轴（竖轴）转动，切向在 X-Z 平面内
  const orbV  = Math.sqrt((gravitationalConstant() * blackHole.mass) / Math.max(dist, 40));
  const horizXZ = Math.hypot(dx, dz) || 1;

  const body = bodyTemplate();
  const mass = rand(body.massMin, body.massMax) * sector.bodyScale;
  stars.push({
    x, y, z,
    vx: (-dz / horizXZ) * orbV + rand(-8, 8),   // X-Z 平面切向
    vy:  rand(-4, 4),                             // 轻微垂直扰动
    vz:  ( dx / horizXZ) * orbV + rand(-8, 8),   // X-Z 平面切向
    mass, density: body.density, radius: calcBodyRadius(mass, body.density),
    type: body.type, hue: body.hueBase, sat: body.sat, light: body.light,
    rot: rand(0, Math.PI * 2), rotSpeed: rand(-0.7, 0.7),
    chunkKey: cx + "," + cz,
  });
}

function ensureActiveChunks() {
  // 区块在 X-Z 水平面（与 WASD 移动面一致）
  const ccx = Math.floor(blackHole.x / SIM.chunkSize);
  const ccz = Math.floor(blackHole.z / SIM.chunkSize);
  const needed = new Set();
  const R = SIM.activeChunkRadius;
  for (let ddx = -R; ddx <= R; ddx++) {
    for (let ddz = -R; ddz <= R; ddz++) {
      const kx = ccx + ddx, kz = ccz + ddz, key = kx + "," + kz;
      needed.add(key);
      if (!activeChunks.has(key)) {
        const n = SIM.starsPerChunkBase + getCurrentSectorIndex() * 2;
        for (let i = 0; i < n; i++) spawnBodyInChunk(kx, kz);
        activeChunks.add(key);
      }
    }
  }
  for (const k of activeChunks) if (!needed.has(k)) activeChunks.delete(k);
}

// 
//  吸积盘粒子（物理参数）
// 
// Shakura-Sunyaev 标准薄盘近似：
//   温度梯度 T ∝ r^(-3/4)
//   开普勒角速度 ω ∝ r^(-3/2)
//   粒子面密度 Σ ∝ r^(-1)
//   相对论光行差（多普勒）：I_obs = I_emit × (1 + β·cosφ)^3
const DISK_PHY = {
  r_isco:    1.28,   // 最内稳定圆轨道（单位 PR）
  r_outer:   5.80,   // 外缘
  n_total:   780,    // 粒子总数
  omega0:    2.50,   // ISCO 处角速度 (rad/game-sec)
  beta_isco: 0.46,   // ISCO 处 v/c（相对论速度因子）
};

// 盘温度 → HSL 颜色（T_norm ∈ [0,1]，1 = ISCO 最热端）
// 对应物理：T_norm≈1 → ~10^7 K 蓝白；外侧逐渐变橙红
function diskTempColor(T_norm, dopplerCos) {
  const t = Math.max(0.04, Math.min(1.0, T_norm));
  let h, s, l;
  if (t > 0.72) {
    const f = (t - 0.72) / 0.28;
    h = 45  + f * 162;   // 黄(45°) → 蓝白(207°)
    s = 88  - f * 30;
    l = 84  + f * 12;
  } else if (t > 0.40) {
    const f = (t - 0.40) / 0.32;
    h = 18  + f * 27;    // 橙(18°) → 黄(45°)
    s = 96  - f * 8;
    l = 62  + f * 22;
  } else {
    const f = t / 0.40;
    h = 5   + f * 13;    // 深红(5°) → 橙(18°)
    s = 80  + f * 16;
    l = 30  + f * 32;
  }
  // 相对论多普勒色移：趋近 → 蓝移（h 减小）；远离 → 红移（h 增大）
  h = Math.max(0,  Math.min(280, h - dopplerCos * 62));
  l = Math.max(5,  Math.min(100, l + dopplerCos * 20));
  s = Math.max(40, Math.min(100, s + Math.abs(dopplerCos) * 10));
  return { h: Math.round(h), s: Math.round(s), l: Math.round(l) };
}

function initDiskParticles() {
  diskParticles.length = 0;
  const { r_isco, r_outer, n_total, omega0, beta_isco } = DISK_PHY;
  for (let i = 0; i < n_total; i++) {
    // 逆变换采样 Σ ∝ 1/r 分布 → 内圈粒子密度更高
    const u  = Math.random();
    const r  = r_isco * Math.pow(r_outer / r_isco, u);
    // 开普勒角速度（内轨道快得多）
    const omega  = omega0 * Math.pow(r_isco / r, 1.5);
    // 温度归一化（薄盘 T ∝ r^(-3/4)）
    const T_norm = Math.pow(r_isco / r, 0.75);
    // 该轨道的相对论速度因子
    const beta_r = beta_isco * Math.sqrt(r_isco / r);
    diskParticles.push({
      angle:      Math.random() * Math.PI * 2,
      r, omega, T_norm, beta_r,
      // 径向湍流（模拟磁流体动力学扰动）
      turbAmp:    0.022 + 0.055 * Math.random(),
      turbPhase:  Math.random() * Math.PI * 2,
      turbFreq:   0.28 + 1.6 * Math.random(),
      brightness: 0.55 + 0.45 * Math.random(),
    });
  }
}

function initDiskBands() {
  diskBands.length = 0;
  const bandCount = 56;
  for (let i = 0; i < bandCount; i++) {
    const frac = i / Math.max(1, bandCount - 1);
    const radius = DISK_PHY.r_isco + Math.pow(frac, 0.92) * (DISK_PHY.r_outer - DISK_PHY.r_isco);
    const T_norm = Math.pow(DISK_PHY.r_isco / radius, 0.75);
    diskBands.push({
      radius,
      T_norm,
      thickness: 0.02 + Math.random() * 0.04,
      alpha: 0.22 + Math.random() * 0.38,
      noiseAmp: 0.012 + Math.random() * 0.026,
      noiseFreq: 2.4 + Math.random() * 5.4,
      phase: Math.random() * Math.PI * 2,
      drift: 0.18 + Math.random() * 0.7,
      radialDrift: 0.16 + Math.random() * 0.48,
      radialPhase: Math.random() * Math.PI * 2,
      hueShift: rand(-14, 16),
    });
  }
}

// 每帧按各粒子自身开普勒角速度积分角度
function updateDiskParticles(dt) {
  for (const dp of diskParticles) {
    dp.angle     += dp.omega * dt;
    dp.turbPhase += dp.turbFreq * dt;
    if (dp.angle > Math.PI * 2) dp.angle -= Math.PI * 2;
  }
}

// 
//  世界初始化
// 
function createWorld(savedState = null) {
  stars.length = activeChunks.clear() || 0;
  deepStars.length = absorptionFlashes.length = 0;
  blackHole.mass = 1000; blackHole.eaten = 0;
  blackHole.x = blackHole.y = blackHole.vx = blackHole.vy = blackHole.vz = 0;
  blackHole.z = 120;
  bhScalePulse = 1.0;
  unlockedSectorIndex = 0; gameWon = false;

  const savedBlackHole = savedState?.blackHole;
  if (savedBlackHole && typeof savedBlackHole === "object") {
    blackHole.x = finiteOr(0, Number(savedBlackHole.x));
    blackHole.y = finiteOr(0, Number(savedBlackHole.y));
    blackHole.z = finiteOr(120, Number(savedBlackHole.z));
    blackHole.vx = finiteOr(0, Number(savedBlackHole.vx));
    blackHole.vy = finiteOr(0, Number(savedBlackHole.vy));
    blackHole.vz = finiteOr(0, Number(savedBlackHole.vz));
    blackHole.mass = Math.max(1000, finiteOr(1000, Number(savedBlackHole.mass)));
    blackHole.eaten = Math.max(0, Math.floor(finiteOr(0, Number(savedBlackHole.eaten))));
    unlockedSectorIndex = Math.max(0, Math.min(SECTORS.length - 1, Math.floor(finiteOr(0, Number(savedState?.unlockedSectorIndex)))));
    gameWon = Boolean(savedState?.gameWon);
    lastEatMass = Math.max(0, finiteOr(0, Number(savedState?.lastEatMass)));
  }

  camera.yaw = finiteOr(CAMERA_DEFAULT_YAW, Number(savedState?.camera?.yaw));
  camera.pitch = clampValue(finiteOr(CAMERA_DEFAULT_PITCH, Number(savedState?.camera?.pitch)), CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  camera.distance = clampValue(finiteOr(CAMERA_DEFAULT_DISTANCE, Number(savedState?.camera?.distance)), CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX);
  updateCameraOrbitPosition();
  goalStatusEl.classList.toggle("win", gameWon);
  ensureActiveChunks();
  initDiskParticles();
  initDiskBands();
  for (let i = 0; i < 800; i++) {
    const direction = randomDirection3D();
    const distance = rand(2200, 5200);
    deepStars.push({
      x: direction.x * distance,
      y: direction.y * distance,
      z: direction.z * distance,
      size: rand(0.4, 2.2),
      alpha: rand(0.18, 0.9),
    });
  }
  updateProgression();
}

function restartGame() {
  keys.clear();
  mouseDown = false;
  viewDragging = false;
  canvas.style.cursor = "crosshair";
  clearSavedGame();
  createWorld();
  lastTime = performance.now();
  updateHud();
  saveGame(true);
  // 多人联机模式下通知服务器重生
  if (typeof onGameRestart === "function") onGameRestart();
}

// 
//  输入（WASD/方向键 = 跟随当前视角的水平面移动）
// 
function handleInput(dt) {
  const boost = keys.has("Shift") ? 2.2 : 1.0;
  const A = 320 * boost;
  let ax = 0, az = 0;
  const forwardX = Math.sin(camera.yaw);
  const forwardZ = Math.cos(camera.yaw);
  const rightX = Math.cos(camera.yaw);
  const rightZ = -Math.sin(camera.yaw);

  if (keys.has("ArrowUp") || keys.has("w")) {
    ax -= forwardX * A;
    az -= forwardZ * A;
  }
  if (keys.has("ArrowDown") || keys.has("s")) {
    ax += forwardX * A;
    az += forwardZ * A;
  }
  if (keys.has("ArrowLeft") || keys.has("a")) {
    ax -= rightX * A;
    az -= rightZ * A;
  }
  if (keys.has("ArrowRight") || keys.has("d")) {
    ax += rightX * A;
    az += rightZ * A;
  }

  // 鼠标按住：向光标方向加速（俯视2D直觉操作）
  if (mouseDown) {
    const mx = mousePos.x - width  * 0.5;
    const my = mousePos.y - height * 0.5;
    const mlen = Math.hypot(mx, my);
    if (mlen > 8) { ax += (mx / mlen) * A; az += (my / mlen) * A; }
  }

  blackHole.vx = (blackHole.vx + ax*dt) * SIM.drag;
  blackHole.vy *= SIM.drag;          // 无垂直输入，仅自然衰减
  blackHole.vz = (blackHole.vz + az*dt) * SIM.drag;
  const spd = Math.hypot(blackHole.vx, blackHole.vy, blackHole.vz);
  if (spd > SIM.maxSpeed) { const f = SIM.maxSpeed/spd; blackHole.vx*=f; blackHole.vy*=f; blackHole.vz*=f; }

  blackHole.x += blackHole.vx * dt;
  blackHole.y += blackHole.vy * dt;
  blackHole.z += blackHole.vz * dt;

  updateCameraOrbitPosition();
}

// 
//  物理积分
// 
function spawnAbsorptionFlash(star) {
  const hue  = star.type==="star"?45:star.type==="planet"?180:28;
  const life = star.type==="star"?0.72:star.type==="planet"?0.48:0.28;
  absorptionFlashes.push({ x:star.x, y:star.y, z:star.z, hue, size:star.radius*18, alpha:1, timer:life, maxTimer:life });
}

function massGainFactor(type) { return type==="star"?1.0:type==="planet"?0.88:0.68; }

function integrateStars(dt) {
  ensureActiveChunks();
  const horizon = eventHorizon(), tidal = tidalRadius(), G = gravitationalConstant();

  for (let i = stars.length - 1; i >= 0; i--) {
    const s  = stars[i];
    const dx = blackHole.x - s.x, dy = blackHole.y - s.y, dz = blackHole.z - s.z;

    // 原始距离（用于方向归一化 + 吞噬判断）
    const rawDist2 = dx*dx + dy*dy + dz*dz;
    const rawDist  = Math.sqrt(rawDist2);

    // 软化距离（用于引力大小，防止近距力爆炸）
    const soft2    = SIM.softening * SIM.softening;  // 30² = 900
    const softDist2 = rawDist2 + soft2;

    // 引力加速度（方向用 rawDist 归一化，大小用 softDist2）
    let accel = (G * blackHole.mass) / softDist2;
    if (rawDist < tidal) accel *= 1 + 4.5 * Math.pow(1 - rawDist / tidal, 1.6);

    const inv = 1 / Math.max(rawDist, 0.001);
    s.vx += dx * inv * accel * dt;
    s.vy += dy * inv * accel * dt;
    s.vz += dz * inv * accel * dt;

    // 轨道衰减（潮汐区内加强）
    const decay = rawDist < tidal ? 0.9980 : 0.9995;
    s.vx *= decay; s.vy *= 0.9985; s.vz *= decay;

    s.x += s.vx*dt; s.y += s.vy*dt; s.z += s.vz*dt;
    s.rot += s.rotSpeed * dt;

    // 吞噬：用原始 3D 距离
    if (rawDist < horizon) {
      const gain = s.mass * massGainFactor(s.type);
      blackHole.mass += gain; blackHole.eaten++; lastEatMass = gain;
      // 脏吐脉冲：被吸质量占当前质量比例越大，膨胀越明显
      const pulsePct = gain / blackHole.mass;
      bhScalePulse = Math.min(bhScalePulse + pulsePct * 6.0, 1.85);
      const ir = Math.min(0.012, s.mass / blackHole.mass);
      blackHole.vx += (s.vx - blackHole.vx) * ir;
      blackHole.vy += (s.vy - blackHole.vy) * ir;
      blackHole.vz += (s.vz - blackHole.vz) * ir;
      spawnAbsorptionFlash(s);
      saveGame(true);
      stars.splice(i, 1); continue;
    }

    // 回收：用黑洞坐标判断 X-Z 水平面超界 + Y 轴超界
    const maxOff = SIM.chunkSize * (SIM.activeChunkRadius + 1.8);
    if (Math.abs(s.x - blackHole.x) > maxOff ||
        Math.abs(s.z - blackHole.z) > maxOff ||
        Math.abs(s.y - blackHole.y) > 600) {
      stars.splice(i, 1);
    }
  }

  for (let i = absorptionFlashes.length - 1; i >= 0; i--) {
    const f = absorptionFlashes[i];
    f.timer -= dt; f.alpha = Math.max(0, f.timer/f.maxTimer);
    if (f.timer <= 0) absorptionFlashes.splice(i,1);
  }
}

function updateProgression() {
  while (unlockedSectorIndex < SECTORS.length-1 && blackHole.mass >= SECTORS[unlockedSectorIndex].targetMass) unlockedSectorIndex++;
  if (!gameWon && blackHole.mass >= SECTORS[SECTORS.length-1].targetMass) { gameWon=true; goalStatusEl.classList.add("win"); }
}

// 
//  渲染
// 
function drawBackground() {
  const g = ctx.createRadialGradient(width*.5,height*.45,60,width*.5,height*.45,Math.max(width,height)*.9);
  g.addColorStop(0,"#0d1a44"); g.addColorStop(0.4,"#090e26"); g.addColorStop(1,"#020309");
  ctx.fillStyle = g; ctx.fillRect(0,0,width,height);
  const t = performance.now()*0.001;
  const blackHoleProjection = project(blackHole.x, blackHole.y, blackHole.z);
  const blackHoleScreenRadius = blackHoleProjection ? bhRadius() * blackHoleProjection.scale * bhScalePulse : 0;
  for (const s of deepStars) {
    const p = project(camera.x + s.x, camera.y + s.y, camera.z + s.z);
    if (!p||p.x<-10||p.x>width+10||p.y<-10||p.y>height+10) continue;
    const tw = 0.55 + Math.sin((t+s.x*0.003)*2.4)*0.28;
    let drawX = p.x;
    let drawY = p.y;
    let stretch = 1;
    let rotation = 0;
    if (blackHoleProjection) {
      const dx = p.x - blackHoleProjection.x;
      const dy = p.y - blackHoleProjection.y;
      const dist = Math.hypot(dx, dy);
      const influenceRadius = Math.max(blackHoleScreenRadius * 7.6, 120);
      if (dist > blackHoleScreenRadius * 1.08 && dist < influenceRadius) {
        const unitX = dx / Math.max(dist, 0.0001);
        const unitY = dy / Math.max(dist, 0.0001);
        const falloff = 1 - dist / influenceRadius;
        const lensStrength = falloff * falloff;
        const radialPush = blackHoleScreenRadius * (0.24 + lensStrength * 1.35);
        drawX += unitX * radialPush * lensStrength;
        drawY += unitY * radialPush * lensStrength;
        stretch = 1 + lensStrength * 2.4;
        rotation = Math.atan2(unitY, unitX) + Math.PI / 2;
      }
    }
    ctx.globalAlpha = s.alpha * tw;
    ctx.fillStyle = "#cce8ff";
    const baseSize = s.size * Math.min(p.scale * 12, 2.5);
    ctx.save();
    ctx.translate(drawX, drawY);
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.ellipse(0, 0, baseSize * stretch, baseSize, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function getDiskViewFactors() {
  const sinPitch = Math.abs(Math.sin(camera.pitch));
  return {
    ry: sinPitch * 0.92 + 0.08,
    edgeOn: Math.max(0, 1 - sinPitch),
  };
}

function drawDiskHeatGlow(px, py, PR, ry, edgeOn) {
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, ry);
  const glowSteps = 9;
  for (let g = glowSteps - 1; g >= 0; g--) {
    const frac = g / (glowSteps - 1);
    const rFrac = DISK_PHY.r_isco + frac * (DISK_PHY.r_outer - DISK_PHY.r_isco);
    const T = Math.pow(DISK_PHY.r_isco / rFrac, 0.75);
    const col = diskTempColor(T, 0.18 - frac * 0.12);
    const rS = rFrac * PR;
    const rE = Math.min(rS * (2.05 + edgeOn * 0.35), DISK_PHY.r_outer * PR * 1.18);
    const coreAlpha = (0.05 + 0.24 * T) * (0.38 + 0.62 * (1 - frac));
    const grd = ctx.createRadialGradient(0, 0, rS * 0.62, 0, 0, rE);
    grd.addColorStop(0, `hsla(${col.h},${col.s}%,${col.l + 8}%,0)`);
    grd.addColorStop(0.18, `hsla(${col.h},${col.s}%,${col.l + 4}%,${coreAlpha * 0.78})`);
    grd.addColorStop(0.5, `hsla(${col.h + 10},${Math.max(0, col.s - 12)}%,${Math.max(0, col.l - 12)}%,${coreAlpha})`);
    grd.addColorStop(0.82, `hsla(${col.h + 24},${Math.max(0, col.s - 28)}%,${Math.max(0, col.l - 30)}%,${coreAlpha * 0.34})`);
    grd.addColorStop(1, `hsla(${col.h + 34},${Math.max(0, col.s - 34)}%,${Math.max(0, col.l - 42)}%,0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(0, 0, rE, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDiskParticleLayer(px, py, PR, ry, edgeOn, options) {
  const {
    front,
    lensed = false,
    mirror = false,
    alphaScale = 1,
    stretchX = 1,
    stretchY = 1,
    liftScale = 0,
    widthScale = 1,
  } = options;

  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, ry);
  ctx.globalCompositeOperation = lensed ? "screen" : "lighter";

  for (const dp of diskParticles) {
    const sinA = Math.sin(dp.angle);
    if (front ? sinA < 0 : sinA >= 0) continue;

    const cosA = Math.cos(dp.angle);
    const turbR = dp.r + dp.turbAmp * Math.sin(dp.turbPhase);
    const baseX = cosA * turbR * PR;
    const baseY = sinA * turbR * PR;
    const lensWeight = edgeOn * Math.exp(-Math.abs(baseX) / Math.max(PR * 2.4, 1)) * (0.32 + 0.68 * dp.T_norm);
    const dCos = cosA * (0.2 + edgeOn * 0.8);
    const D = 1.0 + dp.beta_r * dCos;
    const beam = D * D * D;
    const col = diskTempColor(dp.T_norm, dCos * 0.78);
    const baseAlpha = (0.09 + 0.64 * dp.T_norm) * dp.brightness;

    let sx = baseX * stretchX * (1 + lensWeight * 0.08);
    let sy = baseY * stretchY;

    if (lensed) {
      const lift = PR * liftScale * (0.3 + 0.7 * dp.T_norm) * (0.28 + lensWeight * 1.4);
      sy = (mirror ? -baseY : baseY) * (0.08 + edgeOn * 0.18) + (mirror ? -1 : 1) * lift;
      sx *= 1 + lensWeight * 0.12;
    }

    const alpha = Math.min(0.98, baseAlpha * beam * alphaScale * (lensed ? 0.7 + lensWeight * 1.6 : 0.5 + 0.5 * Math.abs(sinA)));
    const major = Math.max(0.7, (PR * (0.016 + 0.038 * dp.T_norm) + dp.brightness * 0.4) * widthScale * (1 + edgeOn * 1.8));
    const minor = Math.max(0.4, major * (lensed ? 0.14 + edgeOn * 0.08 : 0.28));

    ctx.globalAlpha = alpha;
    ctx.fillStyle = `hsl(${col.h},${col.s}%,${col.l}%)`;
    ctx.beginPath();
    ctx.ellipse(sx, sy, major, minor, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawDiskMidplaneBridge(px, py, PR, ry, edgeOn) {
  const outerRadius = DISK_PHY.r_outer * PR;
  const bridgeHalfHeight = Math.max(PR * (0.085 + edgeOn * 0.065), 4);

  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, ry);
  ctx.globalCompositeOperation = "screen";

  const bridgeGlow = ctx.createLinearGradient(-outerRadius, 0, outerRadius, 0);
  bridgeGlow.addColorStop(0, "rgba(255,188,120,0)");
  bridgeGlow.addColorStop(0.14, `rgba(255,198,132,${0.18 + edgeOn * 0.1})`);
  bridgeGlow.addColorStop(0.32, `rgba(255,226,178,${0.34 + edgeOn * 0.16})`);
  bridgeGlow.addColorStop(0.5, `rgba(244,248,255,${0.46 + edgeOn * 0.18})`);
  bridgeGlow.addColorStop(0.68, `rgba(255,226,178,${0.34 + edgeOn * 0.16})`);
  bridgeGlow.addColorStop(0.86, `rgba(255,198,132,${0.18 + edgeOn * 0.1})`);
  bridgeGlow.addColorStop(1, "rgba(255,188,120,0)");

  ctx.fillStyle = bridgeGlow;
  ctx.beginPath();
  ctx.ellipse(0, 0, outerRadius * 1.02, bridgeHalfHeight, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.45 + edgeOn * 0.2;
  ctx.strokeStyle = "rgba(255,248,232,1)";
  ctx.lineWidth = Math.max(1.2, PR * 0.024);
  ctx.beginPath();
  ctx.moveTo(-outerRadius * 0.94, 0);
  ctx.lineTo(outerRadius * 0.94, 0);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.globalCompositeOperation = "source-over";
}

function drawDiskFlowBands(px, py, PR, ry, edgeOn, now, options) {
  const {
    front,
    lensed = false,
    mirror = false,
    alphaScale = 1,
    liftScale = 0,
    widthScale = 1,
    stretchX = 1,
    stretchY = 1,
  } = options;

  const seamOverlap = 0.12;
  const startAngle = front ? -seamOverlap : Math.PI - seamOverlap;
  const endAngle = front ? Math.PI + seamOverlap : Math.PI * 2 + seamOverlap;
  const angleSteps = lensed ? 44 : 56;

  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, ry);
  ctx.globalCompositeOperation = lensed ? "screen" : "lighter";

  for (const band of diskBands) {
    const dCosBias = front ? 0.22 : -0.12;
    const col = diskTempColor(band.T_norm, dCosBias + edgeOn * 0.32);
    const baseRadius = band.radius * PR;
    const wobbleTime = now * 0.001 * band.drift;
    const driftTime = now * 0.001 * band.radialDrift;
    const lineWidth = Math.max(
      0.55,
      PR * band.thickness * (lensed ? 0.48 + edgeOn * 0.32 : 0.72) * widthScale
    );

    ctx.beginPath();
    for (let stepIndex = 0; stepIndex <= angleSteps; stepIndex++) {
      const t = stepIndex / angleSteps;
      const angle = startAngle + (endAngle - startAngle) * t;
      const angleWave = Math.sin(angle * band.noiseFreq + band.phase + wobbleTime) * band.noiseAmp;
      const twistWave = Math.sin(angle * (band.noiseFreq * 0.55) - wobbleTime * 1.7) * band.noiseAmp * 0.6;
      const inflowWave = Math.sin(angle * (1.2 + band.T_norm * 2.4) - driftTime * 5.2 + band.radialPhase);
      const inflowPulse = (0.5 + 0.5 * inflowWave) * (0.012 + band.T_norm * 0.05);
      const radius = baseRadius * (1 + angleWave + twistWave - inflowPulse);
      let x = Math.cos(angle) * radius * stretchX;
      let y = Math.sin(angle) * radius * stretchY;

      if (lensed) {
        const focus = Math.exp(-Math.abs(x) / Math.max(PR * 2.8, 1));
        const lift = PR * liftScale * (0.26 + 0.74 * band.T_norm) * (0.44 + focus * (0.8 + edgeOn));
        y = (mirror ? -y : y) * (0.12 + edgeOn * 0.18) + (mirror ? -1 : 1) * lift;
        x *= 1 + focus * 0.12;
      }

      if (stepIndex === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.globalAlpha = Math.min(
      0.88,
      band.alpha * alphaScale * (lensed ? 0.48 + edgeOn * 1.12 : 0.34 + band.T_norm * 0.52)
    );
    ctx.strokeStyle = `hsla(${col.h + band.hueShift},${col.s}%,${clampValue(col.l + (lensed ? 10 : 2), 0, 100)}%,1)`;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawPhotonRing(px, py, PR, ry, edgeOn) {
  const ringRadius = PR * 1.16;
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, ry);

  const ring = ctx.createRadialGradient(0, 0, ringRadius * 0.78, 0, 0, ringRadius * 1.34);
  ring.addColorStop(0, "rgba(255,250,228,0)");
  ring.addColorStop(0.2, `rgba(255,248,214,${0.45 + edgeOn * 0.22})`);
  ring.addColorStop(0.4, `rgba(255,222,128,${0.86 + edgeOn * 0.08})`);
  ring.addColorStop(0.62, `rgba(255,162,52,${0.58 + edgeOn * 0.18})`);
  ring.addColorStop(0.84, "rgba(179,72,10,0.24)");
  ring.addColorStop(1, "rgba(110,26,0,0)");
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius * 1.34, 0, Math.PI * 2);
  ctx.fill();

  const caustic = ctx.createRadialGradient(0, -PR * (0.1 + edgeOn * 0.22), ringRadius * 0.88, 0, 0, ringRadius * 1.12);
  caustic.addColorStop(0, "rgba(255,255,240,0)");
  caustic.addColorStop(0.45, `rgba(255,241,180,${0.34 + edgeOn * 0.18})`);
  caustic.addColorStop(0.7, `rgba(255,208,120,${0.2 + edgeOn * 0.14})`);
  caustic.addColorStop(1, "rgba(255,180,80,0)");
  ctx.fillStyle = caustic;
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius * 1.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEinsteinRingArcs(px, py, PR, edgeOn, now) {
  const arcCount = 4;
  const baseRadius = PR * (1.46 + edgeOn * 0.24);
  const time = now * 0.001;

  ctx.save();
  ctx.translate(px, py);
  ctx.globalCompositeOperation = "screen";

  for (let i = 0; i < arcCount; i++) {
    const phase = time * (0.22 + i * 0.05) + i * 1.47;
    const radius = baseRadius * (1 + Math.sin(phase * 0.8) * 0.035);
    const arcSpan = Math.PI * (0.22 + edgeOn * 0.12 + i * 0.015);
    const start = phase + i * 0.9;
    const end = start + arcSpan;
    const lineWidth = Math.max(1.4, PR * (0.045 + edgeOn * 0.018) * (1 - i * 0.14));
    const alpha = (0.16 + edgeOn * 0.22) * (1 - i * 0.16);

    const grad = ctx.createRadialGradient(0, 0, radius * 0.76, 0, 0, radius * 1.08);
    grad.addColorStop(0, "rgba(255,250,235,0)");
    grad.addColorStop(0.52, `rgba(255,232,168,${alpha})`);
    grad.addColorStop(0.78, `rgba(173,214,255,${alpha * 0.82})`);
    grad.addColorStop(1, "rgba(120,170,255,0)");

    ctx.strokeStyle = grad;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, radius, start, end);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = "rgba(255,248,218,1)";
    ctx.lineWidth = Math.max(0.6, lineWidth * 0.24);
    ctx.beginPath();
    ctx.arc(0, 0, radius * (0.992 + i * 0.004), start + 0.04, end - 0.03);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
  ctx.globalCompositeOperation = "source-over";
}

function drawAccretionDisk(px, py, PR, _now) {
  const { ry, edgeOn } = getDiskViewFactors();
  const now = performance.now();

  drawDiskHeatGlow(px, py, PR, ry, edgeOn);
  drawDiskMidplaneBridge(px, py, PR, ry, edgeOn);

  drawDiskFlowBands(px, py, PR, ry, edgeOn, now, {
    front: false,
    alphaScale: 0.72,
    widthScale: 0.92,
    stretchX: 1,
    stretchY: 1,
  });

  drawDiskParticleLayer(px, py, PR, ry, edgeOn, {
    front: false,
    alphaScale: 0.72,
    stretchX: 1,
    stretchY: 1,
    widthScale: 0.92,
  });

  if (edgeOn > 0.04) {
    drawDiskFlowBands(px, py, PR, ry, edgeOn, now, {
      front: false,
      lensed: true,
      mirror: false,
      alphaScale: 0.5,
      liftScale: 1.14,
      widthScale: 1.18,
      stretchX: 1.08,
      stretchY: 0.42,
    });
    drawDiskFlowBands(px, py, PR, ry, edgeOn, now, {
      front: false,
      lensed: true,
      mirror: true,
      alphaScale: 0.46,
      liftScale: 1.2,
      widthScale: 1.08,
      stretchX: 1.12,
      stretchY: 0.4,
    });
    drawDiskParticleLayer(px, py, PR, ry, edgeOn, {
      front: false,
      lensed: true,
      mirror: false,
      alphaScale: 0.62,
      stretchX: 1.08,
      stretchY: 0.46,
      liftScale: 1.22,
      widthScale: 1.15,
    });
    drawDiskParticleLayer(px, py, PR, ry, edgeOn, {
      front: false,
      lensed: true,
      mirror: true,
      alphaScale: 0.56,
      stretchX: 1.12,
      stretchY: 0.42,
      liftScale: 1.28,
      widthScale: 1.08,
    });
  }

  drawPhotonRing(px, py, PR, ry, edgeOn);
}

function drawBlackHole(now) {
  const p = project(blackHole.x, blackHole.y, blackHole.z);
  if (!p) return;
  const PR = bhRadius() * p.scale * bhScalePulse;  // 应用脉冲缩放
  const { ry, edgeOn } = getDiskViewFactors();
  const nowSeconds = performance.now();

  // 潮汐圈
  const tidalPR = tidalRadius() * p.scale;
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = "rgba(130,200,255,0.8)"; ctx.lineWidth = 1.0;
  ctx.beginPath(); ctx.ellipse(p.x,p.y, tidalPR,tidalPR*ry, 0,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha = 1;

  // 吸积盘（后半圈在黑洞前绘制）传入已含脉冲的PR
  drawAccretionDisk(p.x, p.y, PR, now);
  drawEinsteinRingArcs(p.x, p.y, PR, edgeOn, nowSeconds);

  // 外层蓝白辉光
  const glow = ctx.createRadialGradient(p.x,p.y,PR*0.9,p.x,p.y,PR*5.5);
  glow.addColorStop(0,   "rgba(120,210,255,0.38)");
  glow.addColorStop(0.35,"rgba(80,160,255,0.14)");
  glow.addColorStop(1,   "rgba(40,80,200,0)");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x,p.y,PR*5.5,0,Math.PI*2); ctx.fill();

  // bh.png 圆形裁剪
  ctx.save();
  ctx.beginPath(); ctx.arc(p.x,p.y,PR,0,Math.PI*2); ctx.clip();
  if (imgBH.complete && imgBH.naturalWidth > 0) {
    ctx.translate(p.x,p.y); ctx.rotate(bhSpinAngle);
    ctx.drawImage(imgBH,-PR,-PR,PR*2,PR*2);
  } else {
    ctx.fillStyle="#000"; ctx.fillRect(p.x-PR,p.y-PR,PR*2,PR*2);
  }
  ctx.restore();

  // 引力透镜边缘光圈
  ctx.globalAlpha = 0.52;
  ctx.strokeStyle = "rgba(100,200,255,0.9)";
  ctx.lineWidth   = Math.max(0.8, PR*0.07);
  ctx.beginPath(); ctx.arc(p.x,p.y,PR,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha = 1;

  const lensGlow = ctx.createRadialGradient(p.x, p.y, PR * 0.95, p.x, p.y, PR * (2.4 + edgeOn * 1.4));
  lensGlow.addColorStop(0, "rgba(255,248,208,0)");
  lensGlow.addColorStop(0.4, `rgba(255,223,142,${0.16 + edgeOn * 0.2})`);
  lensGlow.addColorStop(0.72, `rgba(132,180,255,${0.08 + edgeOn * 0.1})`);
  lensGlow.addColorStop(1, "rgba(60,90,190,0)");
  ctx.fillStyle = lensGlow;
  ctx.beginPath(); ctx.arc(p.x,p.y,PR*(2.4 + edgeOn * 1.4),0,Math.PI*2); ctx.fill();

  // 前半圈粒子（覆盖黑洞本体，含相对论光行差与温度色彩）
  if (edgeOn > 0.04) {
    drawDiskFlowBands(p.x, p.y, PR, ry, edgeOn, nowSeconds, {
      front: true,
      lensed: true,
      mirror: false,
      alphaScale: 0.66,
      liftScale: 1.34,
      widthScale: 1.24,
      stretchX: 1.16,
      stretchY: 0.42,
    });
    drawDiskFlowBands(p.x, p.y, PR, ry, edgeOn, nowSeconds, {
      front: true,
      lensed: true,
      mirror: true,
      alphaScale: 0.62,
      liftScale: 1.42,
      widthScale: 1.18,
      stretchX: 1.18,
      stretchY: 0.4,
    });
    drawDiskParticleLayer(p.x, p.y, PR, ry, edgeOn, {
      front: true,
      lensed: true,
      mirror: false,
      alphaScale: 0.82,
      stretchX: 1.16,
      stretchY: 0.44,
      liftScale: 1.42,
      widthScale: 1.28,
    });
    drawDiskParticleLayer(p.x, p.y, PR, ry, edgeOn, {
      front: true,
      lensed: true,
      mirror: true,
      alphaScale: 0.76,
      stretchX: 1.18,
      stretchY: 0.42,
      liftScale: 1.5,
      widthScale: 1.22,
    });
  }

  drawDiskFlowBands(p.x, p.y, PR, ry, edgeOn, nowSeconds, {
    front: true,
    alphaScale: 0.92,
    widthScale: 1.04,
    stretchX: 1,
    stretchY: 1,
  });

  drawDiskParticleLayer(p.x, p.y, PR, ry, edgeOn, {
    front: true,
    alphaScale: 1,
    stretchX: 1,
    stretchY: 1,
    widthScale: 1.04,
  });
}

function drawStars() {
  const rendered = [];
  for (const star of stars) {
    const p = project(star.x, star.y, star.z);
    if (!p||p.x<-120||p.x>width+120||p.y<-120||p.y>height+120) continue;
    rendered.push({ star, p });
  }
  rendered.sort((a,b) => b.p.fz - a.p.fz);
  for (const { star, p } of rendered) {
    const radius = Math.max(1.8, star.radius * p.scale * 9.5);
    ctx.save();
    ctx.globalAlpha = 0.93;
    ctx.beginPath(); ctx.arc(p.x,p.y,radius,0,Math.PI*2); ctx.clip();
    if (imgAMS.complete && imgAMS.naturalWidth > 0) {
      ctx.translate(p.x,p.y); ctx.rotate(star.rot);
      ctx.drawImage(imgAMS,-radius,-radius,radius*2,radius*2);
    } else {
      ctx.fillStyle = "hsl("+star.hue+","+star.sat+"%,"+star.light+"%)";
      ctx.fillRect(p.x-radius,p.y-radius,radius*2,radius*2);
    }
    ctx.restore();
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = "hsl("+star.hue+","+star.sat+"%,"+star.light+"%)";
    ctx.beginPath(); ctx.arc(p.x,p.y,radius*2.3,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawAbsorptionFlashes() {
  for (const f of absorptionFlashes) {
    const p = project(f.x,f.y,f.z);
    if (!p) continue;
    const r   = f.size * p.scale * (1 + (1-f.alpha)*3.2);
    const grd = ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r);
    grd.addColorStop(0,   "hsla("+f.hue+",100%,92%,"+(f.alpha*0.92)+")");
    grd.addColorStop(0.38,"hsla("+f.hue+",90%,65%,"+(f.alpha*0.55)+")");
    grd.addColorStop(1,   "hsla("+f.hue+",80%,50%,0)");
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fill();
  }
}

// 
//  HUD
// 
function updateHud() {
  const si = getCurrentSectorIndex(), sector = currentSector();
  massEl.textContent   = blackHole.mass.toFixed(1);
  eatEl.textContent    = blackHole.eaten.toString();
  speedEl.textContent  = Math.hypot(blackHole.vx,blackHole.vy,blackHole.vz).toFixed(1);
  sectorEl.textContent = (si+1) + " - " + sector.name;
  posEl.textContent    = "("+blackHole.x.toFixed(0)+", "+blackHole.z.toFixed(0)+")";  // 2D坐标
  goalStatusEl.classList.toggle("win", gameWon);
  if (gameWon) {
    targetMassEl.textContent = SECTORS[SECTORS.length-1].targetMass.toString();
    goalStatusEl.textContent = "胜利：已达到终极质量并吞噬核心星区！可继续无限吞噬探索。"; return;
  }
  const ni = Math.min(si+1, SECTORS.length-1);
  const nextTarget = SECTORS[ni].targetMass;
  targetMassEl.textContent = nextTarget.toString();
  goalStatusEl.classList.remove("win");
  goalStatusEl.textContent = si < SECTORS.length-1
    ? "目标：达到 "+nextTarget+" 质量，解锁第 "+(ni+1)+" 星区（"+SECTORS[ni].name+"）"
    : "最终目标：达到 "+SECTORS[SECTORS.length-1].targetMass+" 质量，赢得胜利";
}

// 
//  主循环
// 
function step(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;
  bhSpinAngle += dt * 0.22;
  // 脉冲平滑衰减回1.0
  bhScalePulse += (1.0 - bhScalePulse) * Math.min(1, dt * 4.5);
  handleInput(dt);
  updateDiskParticles(dt);   // 开普勒积分盘粒子角度
  integrateStars(dt);
  updateProgression();
  drawBackground();
  drawStars();
  drawAbsorptionFlashes();
  drawBlackHole(now);
  drawOtherPlayers();
  updateHud();
  saveGame();
  requestAnimationFrame(step);
}

// 
//  事件
// 
window.addEventListener("resize", resize);
window.addEventListener("keydown", e => {
  const k = e.key.length===1 ? e.key.toLowerCase() : e.key;
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(k)) e.preventDefault();
  if (k === "r") {
    resetCameraView();
    saveGame(true);
  }
  keys.add(k);
});
window.addEventListener("keyup", e => { const k = e.key.length===1?e.key.toLowerCase():e.key; keys.delete(k); });

// 鼠标：按住向目标方向加速
canvas.addEventListener("mousemove", e => { mousePos.x = e.clientX; mousePos.y = e.clientY; });
canvas.addEventListener("mousemove", e => {
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;
  if (!viewDragging) {
    return;
  }
  const deltaX = e.clientX - viewDragLastX;
  const deltaY = e.clientY - viewDragLastY;
  viewDragLastX = e.clientX;
  viewDragLastY = e.clientY;
  if (!e.altKey) {
    viewDragging = false;
    canvas.style.cursor = mouseDown ? "grabbing" : "crosshair";
    return;
  }
  camera.yaw += deltaX * 0.006;
  camera.pitch = clampValue(camera.pitch - deltaY * 0.0045, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  updateCameraOrbitPosition();
});
canvas.addEventListener("mousedown", e => {
  if (e.button !== 0) {
    return;
  }
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;
  if (e.altKey) {
    viewDragging = true;
    viewDragLastX = e.clientX;
    viewDragLastY = e.clientY;
    canvas.style.cursor = "grabbing";
    return;
  }
  mouseDown = true;
  canvas.style.cursor = "grabbing";
});
window.addEventListener("mouseup",   () => {
  mouseDown = false;
  viewDragging = false;
  canvas.style.cursor = "crosshair";
});

// 触摸：单指按住朝目标加速
let lastTouch = null;
canvas.addEventListener("touchstart", e => {
  if (e.touches.length === 1) { mouseDown = true; mousePos.x = e.touches[0].clientX; mousePos.y = e.touches[0].clientY; lastTouch = { x: mousePos.x, y: mousePos.y }; }
});
canvas.addEventListener("touchmove", e => {
  if (e.touches.length === 1) { mousePos.x = e.touches[0].clientX; mousePos.y = e.touches[0].clientY; } e.preventDefault();
}, { passive: false });
canvas.addEventListener("touchend", () => { mouseDown = false; lastTouch = null; });
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
  camera.distance = clampValue(camera.distance * zoomFactor, CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX);
  updateCameraOrbitPosition();
  saveGame(true);
}, { passive: false });
restartBtnEl?.addEventListener("click", restartGame);
window.addEventListener("beforeunload", () => { saveGame(true); });
window.addEventListener("pagehide", () => { saveGame(true); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveGame(true);
  }
});

// ── 多人联机：渲染其他玩家 ──
function drawOtherPlayers() {
  for (const [id, op] of otherPlayers) {
    if (id === myPlayerId || !op.alive) continue;
    const p = project(op.x, blackHole.y, op.z);
    if (!p || p.x < -120 || p.x > width + 120 || p.y < -120 || p.y > height + 120) continue;
    const opRadius = 4 + Math.pow(op.mass, 0.48) * 0.85;
    const PR = opRadius * p.scale;
    // Glow
    const glow = ctx.createRadialGradient(p.x, p.y, PR * 0.5, p.x, p.y, PR * 4);
    glow.addColorStop(0, "rgba(255,80,80,0.35)");
    glow.addColorStop(0.4, "rgba(255,40,40,0.12)");
    glow.addColorStop(1, "rgba(200,20,20,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(p.x, p.y, PR * 4, 0, Math.PI * 2); ctx.fill();
    // Body
    ctx.save();
    ctx.beginPath(); ctx.arc(p.x, p.y, PR, 0, Math.PI * 2); ctx.clip();
    if (imgBH.complete && imgBH.naturalWidth > 0) {
      ctx.translate(p.x, p.y);
      ctx.drawImage(imgBH, -PR, -PR, PR * 2, PR * 2);
    } else {
      ctx.fillStyle = "#300"; ctx.fillRect(p.x - PR, p.y - PR, PR * 2, PR * 2);
    }
    ctx.restore();
    // Edge ring
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = "rgba(255,100,100,0.9)";
    ctx.lineWidth = Math.max(0.8, PR * 0.07);
    ctx.beginPath(); ctx.arc(p.x, p.y, PR, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    // Name tag
    const nameSize = Math.max(10, Math.min(16, PR * 0.6));
    ctx.font = nameSize + "px 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,200,200,0.9)";
    ctx.fillText(op.name, p.x, p.y - PR - 8);
    // Mass label
    ctx.font = (nameSize - 2) + "px 'Segoe UI',sans-serif";
    ctx.fillStyle = "rgba(255,160,160,0.7)";
    ctx.fillText(Math.round(op.mass), p.x, p.y - PR - 8 - nameSize);
  }
}

// ── 多人联机：对外暴露接口 ──
function startGameDeferred(savedState) {
  // 保存服务器设置的位置/质量（multiplayer.js 在调用前已设置 blackHole）
  const serverX = blackHole.x;
  const serverZ = blackHole.z;
  const serverMass = blackHole.mass;
  const serverEaten = blackHole.eaten;
  const savedStars = [...stars]; // 保留服务器发送的星体

  resize();
  createWorld(savedState);

  // 恢复服务器状态
  blackHole.x = serverX;
  blackHole.z = serverZ;
  blackHole.mass = serverMass;
  blackHole.eaten = serverEaten;

  // 合并服务器星体
  for (const s of savedStars) stars.push(s);

  updateCameraOrbitPosition();
  lastTime = performance.now();
  updateHud();
  multiplayerStarted = true;
  requestAnimationFrame(step);
}

//  启动 —— 多人模式下由 multiplayer.js 控制 
resize();
// 不自动启动游戏循环，等待 multiplayer.js 调用 startGameDeferred
