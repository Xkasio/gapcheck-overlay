// Electron 진입점 (개발: start.bat / npm start, 배포: 설치판·포터블 exe)
// 중계 서버를 띄우고 제어 창과 오버레이 창 두 개를 연다.
// 두 오버레이는 위치를 따로 정할 수 있다.
// 전역 단축키. 기본: F6 마인크래프트 테두리없는 창 모드 전환,
// F7 오버레이 위치 옮기기, F8 시작/재시작, F9 정지
const { app, BrowserWindow, dialog, globalShortcut, screen, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const path = require("path");

// 받은 매치와 설정은 사용자 폴더(%APPDATA%\GapCheck Overlay\data)에 저장
process.env.GAPCHECK_DATA = path.join(app.getPath("userData"), "data");
const server = require("./server");
const mcwindow = process.platform === "win32" ? require("./mcwindow") : null;

// 오버레이 창 위치 파일 (채팅은 예전 파일 이름을 그대로 써서 기존 위치 유지)
const BOUNDS_FILES = {
  chat: path.join(app.getPath("userData"), "overlay-bounds.json"),
  status: path.join(app.getPath("userData"), "status-bounds.json"),
};
const KEYS_FILE = path.join(app.getPath("userData"), "keybinds.json");
// 동작 이름 -> 단축키 (Electron accelerator 형식, 빈 문자열 = 없음)
const DEFAULT_KEYS = { start: "F8", stop: "F9", fullscreen: "F6", editOverlay: "F7", toggleAdvancements: "", toggleKeepChat: "" };
const ICON = path.join(__dirname, "build", "icon.png");
const RELEASES_URL = "https://github.com/Xkasio/gapcheck-overlay/releases/latest";
let port = null;
let controlWin = null;
const overlays = {}; // part -> BrowserWindow
let editing = false;
let update = { status: "idle" };
let keybinds = loadKeybinds();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!controlWin) return;
    if (controlWin.isMinimized()) controlWin.restore();
    controlWin.focus();
  });
  app.whenReady().then(init);
}

/**
 * 오버레이 창 크기는 "채팅 크기"(scale)에 맞춘다. 마인크래프트 GUI 1픽셀 = scale px
 *   채팅: 너비 340, 높이 10줄(14) + 여백  /  현황: 같은 너비, 한 줄 높이
 */
function overlaySize(part, scale) {
  const u = Number(scale) || 2;
  return part === "status"
    ? { width: Math.round(340 * u), height: Math.max(48, Math.round(24 * u)) }
    : { width: Math.round(340 * u), height: Math.round(148 * u) };
}

function overlayBounds(part) {
  const { workArea } = screen.getPrimaryDisplay();
  const size = overlaySize(part, server.getState().scale);
  // 기본: 현황은 화면 왼쪽 위, 채팅은 왼쪽 아래(마인크래프트 채팅창 자리)
  const fallback = part === "status"
    ? { x: workArea.x + 8, y: workArea.y + 8 }
    : { x: workArea.x + 8, y: workArea.y + workArea.height - 120 - size.height };
  let pos = fallback;
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILES[part], "utf-8"));
    // 모니터 구성이 바뀌어 화면 밖이면 기본 위치로
    const onScreen = screen.getAllDisplays().some(({ bounds: d }) =>
      b.x < d.x + d.width && b.x + size.width > d.x && b.y < d.y + d.height && b.y + size.height > d.y);
    // 채팅은 아래쪽 끝을 기준으로 저장된 위치 유지 (예전 크기로 저장돼 있어도 아래 끝이 같은 자리)
    if (onScreen) pos = { x: b.x, y: part === "chat" && b.height ? b.y + b.height - size.height : b.y };
  } catch { /* 저장된 위치 없음 */ }
  return { ...pos, ...size };
}

/** 채팅 크기가 바뀌면 창 크기도 맞춘다. 채팅은 아래 끝, 현황은 위 끝을 고정 */
function resizeOverlays(scale) {
  for (const [part, w] of Object.entries(overlays)) {
    if (w.isDestroyed()) continue;
    const old = w.getBounds();
    const size = overlaySize(part, scale);
    if (old.width === size.width && old.height === size.height) continue;
    const y = part === "chat" ? old.y + old.height - size.height : old.y;
    w.setBounds({ x: old.x, y, ...size });
    fs.writeFileSync(BOUNDS_FILES[part], JSON.stringify(w.getBounds()));
  }
}

// "항상 위에 표시" 옵션 (기본 켬)
const onTop = () => server.getState().alwaysOnTop !== false;

function applyAlwaysOnTop() {
  eachOverlay((w) => {
    w.setAlwaysOnTop(onTop(), "screen-saver");
    if (onTop()) w.moveTop();
  });
}

function createOverlay(part) {
  const overlay = new BrowserWindow({
    ...overlayBounds(part),
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    // Windows: 도구 창(WS_EX_TOOLWINDOW)으로 만들어 Alt+Tab 목록에 안 보이게
    type: process.platform === "win32" ? "toolbar" : undefined,
    focusable: false,
    alwaysOnTop: onTop(),
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(onTop(), "screen-saver"); // 테두리 없는 전체화면 게임보다 위
  overlay.setIgnoreMouseEvents(true); // 클릭은 게임으로 통과
  overlay.loadURL(`http://localhost:${port}/overlay.html?electron&part=${part}`);
  overlay.once("ready-to-show", () => overlay.showInactive());
  overlay.on("moved", () => fs.writeFileSync(BOUNDS_FILES[part], JSON.stringify(overlay.getBounds())));
  overlays[part] = overlay;
}

const eachOverlay = (fn) => Object.values(overlays).forEach((w) => !w.isDestroyed() && fn(w));

function createControl() {
  controlWin = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 420,
    minHeight: 500,
    title: "GapCheck Overlay",
    icon: ICON,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
  });
  controlWin.loadURL(`http://localhost:${port}/`);
  // 외부 링크는 기본 브라우저로
  controlWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  controlWin.on("closed", () => app.quit());
}

/** 위치 옮기기 모드: 현황·채팅 창을 모두 드래그할 수 있게 */
function toggleEdit() {
  editing = !editing;
  eachOverlay((w) => {
    w.setIgnoreMouseEvents(!editing);
    w.setFocusable(editing);
    w.webContents.executeJavaScript(`window.setEditMode(${editing})`);
  });
  return { ok: true, editing };
}

function toggleFullscreen() {
  if (!mcwindow) return { ok: false, message: "Windows에서만 지원합니다." };
  const r = mcwindow.toggleBorderless();
  if (r.ok && onTop()) eachOverlay((w) => w.moveTop());
  return r;
}

// 자동 업데이트 (GitHub Releases). 설치판은 백그라운드로 받아 두고 재시작/종료 시 설치,
// 포터블은 스스로 교체할 수 없으므로 새 버전 알림만 띄운다.
function setupAutoUpdate() {
  if (!app.isPackaged) return; // 개발 실행(start.bat)에서는 끔
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  autoUpdater.autoDownload = !portable;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (i) => {
    update = portable ? { status: "available", version: i.version, url: RELEASES_URL } : { status: "downloading", version: i.version, percent: 0 };
  });
  autoUpdater.on("download-progress", (p) => (update = { ...update, percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => {
    // 받는 중에 업데이트 버튼을 눌렀으면 다 받자마자 설치
    if (update.installing) return autoUpdater.quitAndInstall(true, true);
    update = { status: "ready", version: i.version };
  });
  autoUpdater.on("update-not-available", () => (update = { status: "latest" }));
  autoUpdater.on("error", (e) => {
    console.warn("업데이트 확인 실패:", e.message);
    update = { status: "error" };
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---------- 관리자 권한 ----------
const elevated = mcwindow ? mcwindow.isElevated() : true;

/** 관리자 권한으로 다시 실행. UAC 확인 창에서 거절하면 지금 프로그램을 그대로 둔다 */
function relaunchAsAdmin() {
  if (!mcwindow) return { ok: false, message: "Windows에서만 지원합니다." };
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  // --relaunched: 새 프로그램이 이 프로그램의 포트가 비기를 잠깐 기다리게
  const params = [app.isPackaged ? "" : `"${app.getAppPath()}"`, "--relaunched"].filter(Boolean).join(" ");
  // 새 프로그램이 "이미 실행 중"으로 바로 꺼지지 않게 잠금을 먼저 푼다
  app.releaseSingleInstanceLock();
  if (!mcwindow.runAsAdmin(exe, params)) {
    app.requestSingleInstanceLock();
    return { ok: false, message: "관리자 권한 실행이 취소되었습니다." };
  }
  setTimeout(() => app.quit(), 100);
  return { ok: true };
}

// ---------- 단축키 ----------
function loadKeybinds() {
  try {
    return { ...DEFAULT_KEYS, ...JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8")) };
  } catch {
    return { ...DEFAULT_KEYS };
  }
}

const keyActions = () => ({
  start: server.control.start,
  stop: server.control.stop,
  fullscreen: toggleFullscreen,
  editOverlay: toggleEdit,
  toggleAdvancements: () => server.control.toggle("showAdvancements"),
  toggleKeepChat: () => server.control.toggle("keepChat"),
});

/** 지정된 단축키를 모두 다시 등록. 등록 못 한 동작 이름 목록을 돌려준다 */
function registerKeys() {
  globalShortcut.unregisterAll();
  const actions = keyActions();
  const failed = [];
  for (const [action, accelerator] of Object.entries(keybinds)) {
    if (!accelerator || !actions[action]) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, actions[action]);
    } catch { /* 잘못된 형식 */ }
    if (!ok) failed.push(action);
  }
  if (failed.length) console.warn("단축키 등록 실패:", failed.map((a) => `${a}=${keybinds[a]}`).join(", "));
  return failed;
}

function setKeybind({ action, accelerator }) {
  if (!(action in DEFAULT_KEYS)) return { ok: false, message: "알 수 없는 동작입니다." };
  accelerator = String(accelerator ?? "");
  const before = { ...keybinds };
  // 같은 키를 쓰던 다른 동작은 비운다
  for (const k of Object.keys(keybinds)) if (k !== action && accelerator && keybinds[k] === accelerator) keybinds[k] = "";
  keybinds[action] = accelerator;
  if (registerKeys().includes(action)) {
    // 등록 실패면 이전 설정으로 되돌린다
    keybinds = before;
    registerKeys();
    return { ok: false, keybinds, message: `${accelerator} 키를 등록하지 못했습니다. 다른 프로그램이 쓰고 있거나 지원하지 않는 키입니다.` };
  }
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keybinds, null, 2));
  return { ok: true, keybinds };
}

async function init() {
  try {
    // 관리자 권한으로 다시 실행된 경우, 이전 프로그램이 포트를 놓을 때까지 기다려 같은 주소(OBS)를 유지
    port = await server.start({ waitForBasePortMs: process.argv.includes("--relaunched") ? 5000 : 0 });
  } catch (e) {
    console.error(e);
    app.quit();
    return;
  }
  server.hooks.fullscreen = toggleFullscreen;
  server.hooks.editOverlay = toggleEdit;
  server.hooks.info = () => ({ version: app.getVersion(), update, keybinds, admin: elevated });
  server.hooks.setKeybind = setKeybind;
  server.hooks.resetKeybinds = () => {
    keybinds = { ...DEFAULT_KEYS };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keybinds, null, 2));
    registerKeys();
    return { ok: true, keybinds };
  };
  // 제어 창에서 새 키를 입력받는 동안은 전역 단축키를 잠시 끈다
  server.hooks.captureKeys = ({ on }) => {
    if (on) globalShortcut.unregisterAll();
    else registerKeys();
    return { ok: true };
  };
  server.hooks.relaunchAsAdmin = relaunchAsAdmin;
  // 마인크래프트 로그 파일 고르기
  server.hooks.browseLog = async () => {
    const r = await dialog.showOpenDialog(controlWin, {
      title: "마인크래프트 latest.log 선택",
      filters: [{ name: "마인크래프트 로그", extensions: ["log"] }],
      properties: ["openFile"],
    });
    return r.canceled ? { ok: true } : { ok: true, path: r.filePaths[0] };
  };
  server.hooks.installUpdate = () => {
    if (update.status === "downloading") {
      update = { ...update, installing: true }; // 다 받으면 update-downloaded 에서 설치
      return { ok: true };
    }
    if (update.status !== "ready") return { ok: false, message: "받을 업데이트가 없습니다." };
    update = { ...update, installing: true };
    // 설치 화면 없이 조용히 설치하고 다시 실행
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  };

  createOverlay("status");
  createOverlay("chat");
  let lastOnTop = onTop();
  server.onChange((s) => {
    resizeOverlays(s.scale);
    if (onTop() !== lastOnTop) {
      lastOnTop = onTop();
      applyAlwaysOnTop();
    }
  });
  createControl();
  setupAutoUpdate();

  // 게임이 창 순서를 바꿔도 오버레이가 계속 위에 있도록 주기적으로 다시 올린다
  setInterval(() => {
    if (!editing && onTop()) applyAlwaysOnTop();
  }, 2000);

  registerKeys();
}

app.on("will-quit", () => globalShortcut.unregisterAll());
//
