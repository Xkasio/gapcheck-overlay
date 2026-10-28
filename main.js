// Electron 진입점 (개발: start.bat / npm start, 배포: 설치판·포터블 exe)
// 중계 서버를 띄우고 제어 창과 채팅 오버레이(투명·항상 위·클릭 통과) 창을 연다.
// 전역 단축키(게임 중에도 동작): F6 마인크래프트 전체화면(테두리 없음) 전환, F7 오버레이 위치 옮기기,
//                                F8 시작/재시작, F9 정지
const { app, BrowserWindow, globalShortcut, screen, shell } = require("electron");
const fs = require("fs");
const path = require("path");

// 받은 매치와 설정은 사용자 폴더(%APPDATA%\GapCheck Overlay\data)에 저장
process.env.GAPCHECK_DATA = path.join(app.getPath("userData"), "data");
const server = require("./server");
const mcwindow = process.platform === "win32" ? require("./mcwindow") : null;

const BOUNDS_FILE = path.join(app.getPath("userData"), "overlay-bounds.json");
const ICON = path.join(__dirname, "build", "icon.png");
let port = null;
let controlWin = null;
let overlay = null;
let editing = false;

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

  createOverlay();
  createControl();

  // 게임이 창 순서를 바꿔도 오버레이가 계속 위에 있도록 주기적으로 다시 올린다
  setInterval(() => {
    if (overlay && !overlay.isDestroyed() && !editing) {
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.moveTop();
    }
  }, 2000);

  const keys = { F6: toggleFullscreen, F7: toggleEdit, F8: server.control.start, F9: server.control.stop };
  for (const [key, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(key, fn)) console.warn(`단축키 ${key} 등록 실패 (다른 프로그램이 사용 중)`);
  }
}

app.on("will-quit", () => globalShortcut.unregisterAll());
