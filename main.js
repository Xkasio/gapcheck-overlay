// Electron 진입점 (개발: start.bat / npm start, 배포: 설치판·포터블 exe)
// 중계 서버를 띄우고 제어 창과 채팅 오버레이(투명·항상 위·클릭 통과) 창을 연다.
// 전역 단축키(게임 중에도 동작, 제어 창에서 바꿀 수 있음). 기본: F6 마인크래프트 전체화면(테두리 없음) 전환,
// F7 오버레이 위치 옮기기, F8 시작/재시작, F9 정지
const { app, BrowserWindow, globalShortcut, screen, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const path = require("path");

// 받은 매치와 설정은 사용자 폴더(%APPDATA%\GapCheck Overlay\data)에 저장
process.env.GAPCHECK_DATA = path.join(app.getPath("userData"), "data");
const server = require("./server");
const mcwindow = process.platform === "win32" ? require("./mcwindow") : null;

const BOUNDS_FILE = path.join(app.getPath("userData"), "overlay-bounds.json");
const KEYS_FILE = path.join(app.getPath("userData"), "keybinds.json");
// 동작 이름 -> 단축키 (Electron accelerator 형식, 빈 문자열 = 없음)
const DEFAULT_KEYS = { start: "F8", stop: "F9", fullscreen: "F6", editOverlay: "F7", toggleAdvancements: "", toggleKeepChat: "" };
const ICON = path.join(__dirname, "build", "icon.png");
const RELEASES_URL = "https://github.com/cksgh111/gapcheck-overlay/releases/latest";
let port = null;
let controlWin = null;
let overlay = null;
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

function overlayBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  // 기본: 화면 왼쪽 아래, 마인크래프트 채팅창 자리
  const fallback = { x: workArea.x + 8, y: workArea.y + workArea.height - 420, width: 720, height: 300 };
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, "utf-8"));
    // 모니터 구성이 바뀌어 화면 밖이면 기본 위치로
    const onScreen = screen.getAllDisplays().some(({ bounds: d }) =>
      b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y);
    return onScreen ? b : fallback;
  } catch {
    return fallback;
  }
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, "screen-saver"); // 테두리 없는 전체화면 게임보다 위
  overlay.setIgnoreMouseEvents(true); // 클릭은 게임으로 통과
  overlay.loadURL(`http://localhost:${port}/overlay.html?electron`);
  overlay.once("ready-to-show", () => overlay.showInactive());
  overlay.on("moved", () => fs.writeFileSync(BOUNDS_FILE, JSON.stringify(overlay.getBounds())));
}

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

function toggleEdit() {
  editing = !editing;
  overlay.setIgnoreMouseEvents(!editing);
  overlay.setFocusable(editing);
  if (editing) overlay.focus();
  overlay.webContents.executeJavaScript(`window.setEditMode(${editing})`);
  return { ok: true, editing };
}

function toggleFullscreen() {
  if (!mcwindow) return { ok: false, message: "Windows에서만 지원합니다." };
  const r = mcwindow.toggleBorderless();
  if (r.ok) overlay.moveTop();
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
  autoUpdater.on("update-downloaded", (i) => (update = { status: "ready", version: i.version }));
  autoUpdater.on("update-not-available", () => (update = { status: "latest" }));
  autoUpdater.on("error", (e) => {
    console.warn("업데이트 확인 실패:", e.message);
    update = { status: "error" };
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
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
    port = await server.start();
  } catch (e) {
    console.error(e);
    app.quit();
    return;
  }
  server.hooks.fullscreen = toggleFullscreen;
  server.hooks.editOverlay = toggleEdit;
  server.hooks.info = () => ({ version: app.getVersion(), update, keybinds });
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
  server.hooks.installUpdate = () => {
    if (update.status !== "ready") return { ok: false, message: "받아 둔 업데이트가 없습니다." };
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  };

  createOverlay();
  createControl();
  setupAutoUpdate();

  // 게임이 창 순서를 바꿔도 오버레이가 계속 위에 있도록 주기적으로 다시 올린다
  setInterval(() => {
    if (overlay && !overlay.isDestroyed() && !editing) {
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.moveTop();
    }
  }, 2000);

  registerKeys();
}

app.on("will-quit", () => globalShortcut.unregisterAll());
