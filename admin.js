// ============================================================================
//  管理员面板 —— 登录 / 传送 / 登出
// ============================================================================
(() => {
  const ADMIN_USER = "admin";
  const ADMIN_PASS = "admin123";

  const overlay     = document.getElementById("adminOverlay");
  const panel       = document.getElementById("adminPanel");
  const loginBtn    = document.getElementById("adminLoginBtn");
  const closeLogin  = document.getElementById("adminCloseLogin");
  const submitBtn   = document.getElementById("adminSubmit");
  const userInput   = document.getElementById("adminUser");
  const passInput   = document.getElementById("adminPass");
  const errorEl     = document.getElementById("adminError");
  const logoutBtn   = document.getElementById("adminLogout");
  const tpXInput    = document.getElementById("tpX");
  const tpZInput    = document.getElementById("tpZ");
  const tpBtn       = document.getElementById("tpBtn");

  let loggedIn = false;

  function showOverlay()  { if (overlay) overlay.style.display = "flex"; }
  function hideOverlay()  { if (overlay) overlay.style.display = "none"; if (errorEl) errorEl.textContent = ""; }
  function showPanel()    { if (panel) panel.style.display = "block"; }
  function hidePanel()    { if (panel) panel.style.display = "none"; }

  if (loginBtn) loginBtn.addEventListener("click", () => {
    if (loggedIn) { showPanel(); return; }
    showOverlay();
  });

  if (closeLogin) closeLogin.addEventListener("click", hideOverlay);

  if (submitBtn) submitBtn.addEventListener("click", () => {
    const u = userInput?.value.trim();
    const p = passInput?.value;
    if (u === ADMIN_USER && p === ADMIN_PASS) {
      loggedIn = true;
      hideOverlay();
      showPanel();
    } else {
      if (errorEl) errorEl.textContent = "用户名或密码错误";
    }
  });

  if (logoutBtn) logoutBtn.addEventListener("click", () => {
    loggedIn = false;
    hidePanel();
  });

  if (tpBtn) tpBtn.addEventListener("click", () => {
    const tx = parseFloat(tpXInput?.value) || 0;
    const tz = parseFloat(tpZInput?.value) || 0;
    if (typeof blackHole !== "undefined") {
      blackHole.x = tx;
      blackHole.z = tz;
      blackHole.y = 0;
      blackHole.vx = blackHole.vy = blackHole.vz = 0;
      if (typeof updateCameraOrbitPosition === "function") updateCameraOrbitPosition();
      if (typeof saveGame === "function") saveGame(true);
    }
  });

  // 初始隐藏
  hideOverlay();
  hidePanel();
})();
