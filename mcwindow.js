// Windows 관리자 권한 확인 / 관리자 권한으로 다시 실행 (koffi로 shell32 호출)
const koffi = require("koffi");

const shell32 = koffi.load("shell32.dll");

const IsUserAnAdmin = shell32.func("bool __stdcall IsUserAnAdmin()");
const ShellExecuteW = shell32.func("intptr __stdcall ShellExecuteW(void *hwnd, str16 op, str16 file, str16 params, str16 dir, int show)");

/** 관리자 권한으로 실행 중인지. 게임이 관리자 권한이면 이 프로그램도 관리자여야 전역 단축키가 먹힌다 */
const isElevated = () => IsUserAnAdmin();

/** 관리자 권한으로 프로그램 실행 (UAC 확인 창). 확인 창에서 거절하면 false */
const runAsAdmin = (file, params) => Number(ShellExecuteW(null, "runas", file, params, null, 1)) > 32;

module.exports = { isElevated, runAsAdmin };
