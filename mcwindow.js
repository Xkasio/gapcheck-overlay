// 마인크래프트 창을 "테두리 없는 전체화면" <-> 창 모드로 전환 (Windows 전용, koffi로 user32 호출)
// 오버레이가 게임 위에
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const shell32 = koffi.load("shell32.dll");

const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const MONITORINFO = koffi.struct("MONITORINFO", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(void *hwnd, intptr lParam)");

const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lParam)");
const GetClassNameW = user32.func("int __stdcall GetClassNameW(void *hwnd, _Out_ uint8_t *buf, int max)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *hwnd, _Out_ uint8_t *buf, int max)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hwnd)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const GetWindowLongPtrW = user32.func("intptr __stdcall GetWindowLongPtrW(void *hwnd, int index)");
const SetWindowLongPtrW = user32.func("intptr __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr value)");
const SetWindowPos = user32.func("bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32 flags)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)");
const MonitorFromWindow = user32.func("void * __stdcall MonitorFromWindow(void *hwnd, uint32 flags)");
const GetMonitorInfoW = user32.func("bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ MONITORINFO *info)");
const IsUserAnAdmin = shell32.func("bool __stdcall IsUserAnAdmin()");
const ShellExecuteW = shell32.func("intptr __stdcall ShellExecuteW(void *hwnd, str16 op, str16 file, str16 params, str16 dir, int show)");

/** 관리자 권한으로 실행 중인지. 게임이 관리자 권한이면 이 프로그램도 관리자여야 전역 단축키·창 전환이 먹힌다 */
const isElevated = () => IsUserAnAdmin();

/** 관리자 권한으로 프로그램 실행 (UAC 확인 창). 확인 창에서 거절하면 false */
const runAsAdmin = (file, params) => Number(ShellExecuteW(null, "runas", file, params, null, 1)) > 32;

const GWL_STYLE = -16;
const WS_CAPTION = 0x00c00000;
const FRAME = WS_CAPTION | 0x00040000 /* THICKFRAME */ | 0x00080000 /* SYSMENU */ | 0x00020000 /* MINIMIZEBOX */ | 0x00010000; /* MAXIMIZEBOX */
const SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40, SWP_NOOWNERZORDER = 0x200;
const MONITOR_DEFAULTTONEAREST = 2;

const savedRects = new Map(); // hwnd 주소 -> 창 모드였을 때 위치

function readWide(fn, hwnd) {
  const buf = Buffer.alloc(512);
  const n = fn(hwnd, buf, 256);
  return buf.toString("utf16le", 0, n * 2);
}

/** 마인크래프트(GLFW) 창 목록. 앞에 나와 있는 창이 맨 앞 */
function findMinecraftWindows(className = "GLFW30", titlePrefix = "Minecraft") {
  const found = [];
  EnumWindows((hwnd) => {
    if (IsWindowVisible(hwnd) && readWide(GetClassNameW, hwnd) === className) {
      const title = readWide(GetWindowTextW, hwnd);
      if (title.startsWith(titlePrefix)) found.push({ hwnd, title });
    }
    return true;
  }, 0);
  const fg = koffi.address(GetForegroundWindow());
  found.sort((a, b) => (koffi.address(b.hwnd) === fg) - (koffi.address(a.hwnd) === fg));
  return found;
}

/** 테두리 없는 전체화면 <-> 창 모드 전환. 결과: { ok, mode, title } 또는 { ok:false, message } */
function toggleBorderless(win = findMinecraftWindows()[0]) {
  if (process.platform !== "win32") return { ok: false, message: "Windows에서만 지원합니다." };
  if (!win) return { ok: false, message: "실행 중인 마인크래프트 창을 찾지 못했습니다." };

  const { hwnd, title } = win;
  const key = String(koffi.address(hwnd));
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), info);

  if (style & WS_CAPTION) {
    const rect = {};
    GetWindowRect(hwnd, rect);
    savedRects.set(key, rect);
    const m = info.rcMonitor;
    SetWindowLongPtrW(hwnd, GWL_STYLE, style & ~FRAME);
    SetWindowPos(hwnd, null, m.left, m.top, m.right - m.left, m.bottom - m.top, SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
    return { ok: true, mode: "borderless", title };
  }

  // 원래 위치가 없으면 작업 영역 가운데 1280x720
  const w = info.rcWork;
  const r = savedRects.get(key) ?? {
    left: w.left + Math.max(0, (w.right - w.left - 1280) / 2),
    top: w.top + Math.max(0, (w.bottom - w.top - 720) / 2),
    right: 0, bottom: 0,
  };
  const width = r.right ? r.right - r.left : 1280;
  const height = r.bottom ? r.bottom - r.top : 720;
  SetWindowLongPtrW(hwnd, GWL_STYLE, style | FRAME);
  SetWindowPos(hwnd, null, Math.round(r.left), Math.round(r.top), width, height, SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
  savedRects.delete(key);
  return { ok: true, mode: "windowed", title };
}

module.exports = { toggleBorderless, findMinecraftWindows, isElevated, runAsAdmin };
