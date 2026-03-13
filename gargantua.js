// ============================================================================
//  卡冈图雅（Gargantua）—— 坐标原点固定黑洞，独立模块
//  - 固定于 (0, 0, 0)，质量 1000，不移动
//  - 正常牵引周边星体，可吞噬星体（但质量不增长）
//  - 不会被玩家吞噬，玩家会被它吞噬
//  - 每日刷新时重新产生
//  - 外观模仿星际穿越
// ============================================================================

const Gargantua = (() => {
  const INITIAL_MASS = 1000;
  const state = { x: 0, y: 0, z: 0, mass: INITIAL_MASS };

  // 独立吸积盘粒子与流带
  const gParticles = [];
  const gBands = [];
  let gSpinAngle = 0;
  let gScalePulse = 1.0;

  // ---------- 半径公式（与玩家一致） ----------
  function gRadius()  { return 4 + Math.pow(state.mass, 0.48) * 0.85; }
  function gHorizon() { return gRadius() * 1.05; }
  function gTidal()   { return gRadius() * 3.8; }

  // ---------- 初始化 ----------
  function init() {
    state.x = 0; state.y = 0; state.z = 0;
    state.mass = INITIAL_MASS;
    gSpinAngle = 0;
    gScalePulse = 1.0;

    // 吸积盘粒子
    gParticles.length = 0;
    const { r_isco, r_outer, n_total, omega0, beta_isco } = DISK_PHY;
    for (let i = 0; i < n_total; i++) {
      const u = Math.random();
      const r = r_isco * Math.pow(r_outer / r_isco, u);
      const omega = omega0 * Math.pow(r_isco / r, 1.5);
      const T_norm = Math.pow(r_isco / r, 0.75);
      const beta_r = beta_isco * Math.sqrt(r_isco / r);
      gParticles.push({
        angle: Math.random() * Math.PI * 2,
        r, omega, T_norm, beta_r,
        turbAmp: 0.022 + 0.055 * Math.random(),
        turbPhase: Math.random() * Math.PI * 2,
        turbFreq: 0.28 + 1.6 * Math.random(),
        brightness: 0.55 + 0.45 * Math.random(),
      });
    }

    // 吸积盘流带
    gBands.length = 0;
    const bandCount = 56;
    for (let i = 0; i < bandCount; i++) {
      const frac = i / Math.max(1, bandCount - 1);
      const radius = DISK_PHY.r_isco + Math.pow(frac, 0.92) * (DISK_PHY.r_outer - DISK_PHY.r_isco);
      const T_norm = Math.pow(DISK_PHY.r_isco / radius, 0.75);
      gBands.push({
        radius, T_norm,
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

  // ---------- 每帧更新（仅盘粒子旋转） ----------
  function update(dt) {
    gSpinAngle += dt * 0.15;
    gScalePulse += (1.0 - gScalePulse) * Math.min(1, dt * 4.5);
    for (const dp of gParticles) {
      dp.angle += dp.omega * dt;
      dp.turbPhase += dp.turbFreq * dt;
      if (dp.angle > Math.PI * 2) dp.angle -= Math.PI * 2;
    }
  }

  // ---------- 对星体施加引力 + 吞噬进入视界的星体 ----------
  function applyGravityToStars(starsArr, dt, G) {
    const h = gHorizon();
    const t = gTidal();
    for (let i = starsArr.length - 1; i >= 0; i--) {
      const s = starsArr[i];
      const dx = state.x - s.x, dy = state.y - s.y, dz = state.z - s.z;
      const rawDist2 = dx * dx + dy * dy + dz * dz;
      const rawDist = Math.sqrt(rawDist2);
      const softDist2 = rawDist2 + SIM.softening * SIM.softening;

      let accel = (G * state.mass) / softDist2;
      if (rawDist < t) accel *= 1 + 4.5 * Math.pow(1 - rawDist / t, 1.6);

      const inv = 1 / Math.max(rawDist, 0.001);
      s.vx += dx * inv * accel * dt;
      s.vy += dy * inv * accel * dt;
      s.vz += dz * inv * accel * dt;

      // 吞噬星体（Gargantua 质量不增长）
      if (rawDist < h) {
        gScalePulse = Math.min(gScalePulse + 0.08, 1.5);
        starsArr.splice(i, 1);
      }
    }
  }

  // ---------- 对玩家施加引力 + 吞噬判定 ----------
  // 返回 true 表示玩家被吞噬
  function applyGravityToPlayer(bh, dt) {
    const dx = state.x - bh.x, dy = state.y - bh.y, dz = state.z - bh.z;
    const rawDist2 = dx * dx + dy * dy + dz * dz;
    const rawDist = Math.sqrt(rawDist2);
    const h = gHorizon();
    const t = gTidal();

    // 吞噬判定
    if (rawDist < h) return true;

    // 引力拉拽
    const softDist2 = rawDist2 + SIM.softening * SIM.softening;
    const G = gravitationalConstant();
    let accel = (G * state.mass) / softDist2;
    if (rawDist < t) accel *= 1 + 4.5 * Math.pow(1 - rawDist / t, 1.6);

    const inv = 1 / Math.max(rawDist, 0.001);
    bh.vx += dx * inv * accel * dt;
    bh.vy += dy * inv * accel * dt;
    bh.vz += dz * inv * accel * dt;
    return false;
  }

  // ======================================================================
  //  渲染 —— 使用 Gargantua 自身的粒子与流带数据
  // ======================================================================

  // --- 粒子层（使用 gParticles） ---
  function gDrawParticleLayer(px, py, PR, ry, edgeOn, options) {
    const {
      front, lensed = false, mirror = false,
      alphaScale = 1, stretchX = 1, stretchY = 1,
      liftScale = 0, widthScale = 1,
    } = options;

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(1, ry);
    ctx.globalCompositeOperation = lensed ? "screen" : "lighter";

    for (const dp of gParticles) {
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

  // --- 流带（使用 gBands） ---
  function gDrawFlowBands(px, py, PR, ry, edgeOn, now, options) {
    const {
      front, lensed = false, mirror = false,
      alphaScale = 1, liftScale = 0, widthScale = 1,
      stretchX = 1, stretchY = 1,
    } = options;

    const seamOverlap = 0.12;
    const startAngle = front ? -seamOverlap : Math.PI - seamOverlap;
    const endAngle = front ? Math.PI + seamOverlap : Math.PI * 2 + seamOverlap;
    const angleSteps = lensed ? 44 : 56;

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(1, ry);
    ctx.globalCompositeOperation = lensed ? "screen" : "lighter";

    for (const band of gBands) {
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

        if (stepIndex === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
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

  // --- 组合吸积盘绘制 ---
  function gDrawAccretionDisk(px, py, PR) {
    const { ry, edgeOn } = getDiskViewFactors();
    const now = performance.now();

    drawDiskHeatGlow(px, py, PR, ry, edgeOn);
    drawDiskMidplaneBridge(px, py, PR, ry, edgeOn);

    gDrawFlowBands(px, py, PR, ry, edgeOn, now, { front: false, alphaScale: 0.72, widthScale: 0.92, stretchX: 1, stretchY: 1 });
    gDrawParticleLayer(px, py, PR, ry, edgeOn, { front: false, alphaScale: 0.72, stretchX: 1, stretchY: 1, widthScale: 0.92 });

    if (edgeOn > 0.04) {
      gDrawFlowBands(px, py, PR, ry, edgeOn, now, { front: false, lensed: true, mirror: false, alphaScale: 0.5, liftScale: 1.14, widthScale: 1.18, stretchX: 1.08, stretchY: 0.42 });
      gDrawFlowBands(px, py, PR, ry, edgeOn, now, { front: false, lensed: true, mirror: true, alphaScale: 0.46, liftScale: 1.2, widthScale: 1.08, stretchX: 1.12, stretchY: 0.4 });
      gDrawParticleLayer(px, py, PR, ry, edgeOn, { front: false, lensed: true, mirror: false, alphaScale: 0.62, stretchX: 1.08, stretchY: 0.46, liftScale: 1.22, widthScale: 1.15 });
      gDrawParticleLayer(px, py, PR, ry, edgeOn, { front: false, lensed: true, mirror: true, alphaScale: 0.56, stretchX: 1.12, stretchY: 0.42, liftScale: 1.28, widthScale: 1.08 });
    }

    drawPhotonRing(px, py, PR, ry, edgeOn);
  }

  // ---------- 主绘制函数 ----------
  function draw() {
    const p = project(state.x, state.y, state.z);
    if (!p) return;

    const PR = gRadius() * p.scale * gScalePulse;
    const { ry, edgeOn } = getDiskViewFactors();
    const nowSeconds = performance.now();

    // 潮汐圈
    const tidalPR = gTidal() * p.scale;
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = "rgba(255,180,80,0.8)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, tidalPR, tidalPR * ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 吸积盘（后半）
    gDrawAccretionDisk(p.x, p.y, PR);
    drawEinsteinRingArcs(p.x, p.y, PR, edgeOn, nowSeconds);

    // 外层辉光（偏暖金色，区别于玩家的蓝白）
    const glow = ctx.createRadialGradient(p.x, p.y, PR * 0.9, p.x, p.y, PR * 5.5);
    glow.addColorStop(0, "rgba(255,200,120,0.32)");
    glow.addColorStop(0.35, "rgba(200,140,60,0.12)");
    glow.addColorStop(1, "rgba(100,50,10,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PR * 5.5, 0, Math.PI * 2);
    ctx.fill();

    // 黑洞本体（bh.png 圆形裁剪）
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, PR, 0, Math.PI * 2);
    ctx.clip();
    if (imgBH.complete && imgBH.naturalWidth > 0) {
      ctx.translate(p.x, p.y);
      ctx.rotate(gSpinAngle);
      ctx.drawImage(imgBH, -PR, -PR, PR * 2, PR * 2);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(p.x - PR, p.y - PR, PR * 2, PR * 2);
    }
    ctx.restore();

    // 引力透镜边缘光圈（暖色）
    ctx.globalAlpha = 0.58;
    ctx.strokeStyle = "rgba(255,200,120,0.9)";
    ctx.lineWidth = Math.max(0.8, PR * 0.07);
    ctx.beginPath();
    ctx.arc(p.x, p.y, PR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const lensGlow = ctx.createRadialGradient(p.x, p.y, PR * 0.95, p.x, p.y, PR * (2.4 + edgeOn * 1.4));
    lensGlow.addColorStop(0, "rgba(255,248,208,0)");
    lensGlow.addColorStop(0.4, `rgba(255,210,120,${0.18 + edgeOn * 0.22})`);
    lensGlow.addColorStop(0.72, `rgba(200,160,80,${0.10 + edgeOn * 0.12})`);
    lensGlow.addColorStop(1, "rgba(120,80,30,0)");
    ctx.fillStyle = lensGlow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PR * (2.4 + edgeOn * 1.4), 0, Math.PI * 2);
    ctx.fill();

    // 前半圈粒子与流带
    if (edgeOn > 0.04) {
      gDrawFlowBands(p.x, p.y, PR, ry, edgeOn, nowSeconds, { front: true, lensed: true, mirror: false, alphaScale: 0.66, liftScale: 1.34, widthScale: 1.24, stretchX: 1.16, stretchY: 0.42 });
      gDrawFlowBands(p.x, p.y, PR, ry, edgeOn, nowSeconds, { front: true, lensed: true, mirror: true, alphaScale: 0.62, liftScale: 1.42, widthScale: 1.18, stretchX: 1.18, stretchY: 0.4 });
      gDrawParticleLayer(p.x, p.y, PR, ry, edgeOn, { front: true, lensed: true, mirror: false, alphaScale: 0.82, stretchX: 1.16, stretchY: 0.44, liftScale: 1.42, widthScale: 1.28 });
      gDrawParticleLayer(p.x, p.y, PR, ry, edgeOn, { front: true, lensed: true, mirror: true, alphaScale: 0.76, stretchX: 1.18, stretchY: 0.42, liftScale: 1.5, widthScale: 1.22 });
    }

    gDrawFlowBands(p.x, p.y, PR, ry, edgeOn, nowSeconds, { front: true, alphaScale: 0.92, widthScale: 1.04, stretchX: 1, stretchY: 1 });
    gDrawParticleLayer(p.x, p.y, PR, ry, edgeOn, { front: true, alphaScale: 1, stretchX: 1, stretchY: 1, widthScale: 1.04 });

    // 名称标签「卡冈图雅」
    drawNameLabel(p.x, p.y, PR);
  }

  // --- 名称标签 ---
  function drawNameLabel(px, py, PR) {
    const labelY = py + PR + 18;
    ctx.save();
    ctx.font = "bold 13px 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // 发光阴影
    ctx.shadowColor = "rgba(255,180,60,0.7)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(255,220,150,0.92)";
    ctx.fillText("卡冈图雅", px, labelY);

    // 清晰描边
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(80,40,0,0.5)";
    ctx.lineWidth = 2;
    ctx.strokeText("卡冈图雅", px, labelY);
    ctx.fillStyle = "rgba(255,230,170,0.95)";
    ctx.fillText("卡冈图雅", px, labelY);

    ctx.restore();
  }

  // ---------- 重置（每日刷新时调用） ----------
  function reset() {
    init();
  }

  return {
    state,
    init,
    update,
    applyGravityToStars,
    applyGravityToPlayer,
    draw,
    reset,
    gRadius,
    gHorizon,
    gTidal,
  };
})();
