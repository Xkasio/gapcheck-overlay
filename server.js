// GapCheck 로컬 중계 서버
//   node server.js   ->  http://localhost:5174 (브라우저 제어 화면만)
//   npm start        ->  main.js(Electron)가 이 서버를 띄우고 제어 창 + 투명 오버레이 창을 연다
//
// 하는 일
// 1. 브라우저는 gapcheck.gg에 직접 요청할 수 없으므로(다른 주소에서 오면 403) 대신 가져온다.
//    받은 매치는 ../data/matches/{id}.json 에 캐시한다.
// 2. 제어 화면 / 오버레이 창 / OBS 가 같은 상태(매치, 플레이어, 시작 시각)를 보도록
//    상태를 여기 한 곳에 두고 SSE(/api/state/stream)로 실시간 전달한다.
// 3. 마인크래프트 latest.log 를 따라 읽어 내 발전 과제 시각(state.mine)을 기록한다 (비교 표시용).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { LogWatcher, detectLogs, resolveLogPath } = require("./logwatch");
const { loadReplay } = require("./replay");

const BASE_PORT = Number(process.env.PORT) || 5174;
const PUBLIC = path.join(__dirname, "public");
// 배포판(Electron)은 main.js가 사용자 폴더(AppData)로 지정한다
const DATA = process.env.GAPCHECK_DATA || path.join(__dirname, "..", "data");
const CACHE = path.join(DATA, "matches");
/**
 * 랭크드 리플레이 폴더: 마인크래프트 인스턴스의 .minecraft\mcsrranked\replay
 * 연결된 로그(…\.minecraft\logs\latest.log)의 인스턴스를 먼저 보고, 없으면 찾은 인스턴스 중 처음 것
 */
function replayDir() {
  const logs = [resolveLogPath(state.logPath), ...detectLogs().map((l) => l.path)].filter(Boolean);
  for (const log of logs) {
    const dir = path.join(path.dirname(path.dirname(log)), "mcsrranked", "replay");
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}
const STATE_FILE = path.join(DATA, "overlay-state.json");
const UPSTREAM = "https://gapcheck.gg/api";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

// ---------- 공유 상태 ----------
// { matchId, seedType, player:{uuid,nickname,rank,elo}, events:[[ms,type]], stages, startedAt, countdown, scale,
//   showAdvancements, keepChat, showTimes, logPath, log:{path,user,error,last}, mine:[[ms,type]] }
// mine = 이번 시작 이후 내가(로그로 감지) 달성한 발전 과제와 시각
let state = {
  events: [], stages: [], startedAt: null, countdown: 3, scale: 2,
  showAdvancements: true, keepChat: false, showTimes: true, showDelta: true, autoStart: true, alwaysOnTop: true, bgOpacity: 0.5, chatOpacity: 1, logPath: "", log: null, mine: [],
};
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")), startedAt: null, finishedAt: null, mine: [], log: null, preview: false };
} catch { /* 처음 실행 */ }

const clients = new Set();
// Electron이 등록하는 동작 (브라우저로만 실행하면 비어 있음)
const hooks = {};

function setState(patch) {
  state = { ...state, ...patch };
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
  fs.mkdirSync(DATA, { recursive: true });
  // 실행 중에만 의미 있는 값은 저장하지 않음
  const { startedAt, finishedAt, mine, log, preview, ...saved } = state;
  fs.writeFileSync(STATE_FILE, JSON.stringify(saved), "utf-8");
  for (const fn of listeners) fn(state);
}

// Electron(main.js)이 상태 변화를 보고 오버레이 창 크기 등을 맞출 때 쓴다
const listeners = new Set();
const onChange = (fn) => listeners.add(fn);

const control = {
  start: () => state.events.length && setState({ startedAt: Date.now() + (Number(state.countdown) || 0) * 1000, finishedAt: null, mine: [] }),
  stop: () => setState({ startedAt: null, finishedAt: null, mine: [] }),
  toggle: (key) => setState({ [key]: !state[key] }),
};

// ---------- 마인크래프트 로그 ----------
const watcher = new LogWatcher({
  onInfo: (info) => setState({ log: info && { ...state.log, ...info } }),
  // 자동 시작: 매치/월드가 시작되는 순간 타이머 시작 (카운트다운 없이), 새 매치 준비 때 정지
  // 매치 중 월드 리셋: 매치 시계는 계속 가므로 타이머는 두고, 새 월드에서 다시 딸 내 기록만 비운다
  // 내가 완주: 타이머를 그 순간에 멈춰 결과를 남긴다 (매치를 떠나도 다음 매치 준비 때까지 그대로)
  onRun: (what) => {
    const running = state.startedAt != null && state.finishedAt == null;
    if (what === "finish") return running && setState({ finishedAt: Math.max(0, Date.now() - state.startedAt) });
    if (what === "worldReset") return running && setState({ mine: [] });
    if (what === "forfeit") return running && control.stop();
    if (!state.autoStart || !state.events.length) return;
    if (what === "start") setState({ startedAt: Date.now(), finishedAt: null, mine: [] });
    else control.stop();
  },
  onAdvancement: ({ type, mine }) => {
    if (!mine || !type) return;
    const t = state.startedAt == null || state.finishedAt != null ? null : Date.now() - state.startedAt;
    // 타이머가 돌고 있을 때, 같은 발전 과제는 처음 한 번만 기록
    if (t == null || t < 0 || state.mine.some(([, ty]) => ty === type)) return;
    setState({ mine: [...state.mine, [t, type]] });
  },
});

// ---------- gapcheck.gg 중계 ----------
async function getMatch(id) {
  const file = path.join(CACHE, `${id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));

  const r = await fetch(`${UPSTREAM}/matches/${id}`, { headers: { "User-Agent": "gapcheck-overlay (unofficial)" } });
  // 없는 매치는 500 + {"error":"unable to fetch run ..."} 로 온다
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 404 || text.includes("unable to fetch run")) return null;
    throw new Error(`gapcheck.gg 응답 ${r.status}`);
  }
  const { match } = await r.json();
  if (!match) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(match, null, 2), "utf-8");
  return match;
}

// ---------- HTTP ----------
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); }
    });
  });
}

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  const m = pathname.match(/^\/api\/match\/(\d+)$/);
  if (m) {
    try {
      const match = await getMatch(m[1]);
      if (!match) return sendJson(res, 404, { error: "not_found" });
      console.log(`매치 ${m[1]} 전달`);
      return sendJson(res, 200, { match });
    } catch (e) {
      console.error(`매치 ${m[1]} 실패:`, e.message);
      return sendJson(res, 502, { error: "upstream", message: e.message });
    }
  }

  if (pathname === "/api/state/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST") {
    if (pathname === "/api/state") {
      try {
        const patch = await readJson(req);
        setState(patch);
        if ("logPath" in patch) watcher.start(state.logPath);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { error: "bad_json" });
      }
    }
    if (pathname === "/api/start" || pathname === "/api/stop") {
      control[pathname.slice(5)]();
      return sendJson(res, 200, { ok: true });
    }
    const hook = pathname.match(/^\/api\/app\/(\w+)$/);
    if (hook) {
      if (!hooks[hook[1]]) return sendJson(res, 404, { ok: false, message: "앱(start.bat / 설치판)에서만 됩니다." });
      try {
        return sendJson(res, 200, (await hooks[hook[1]](await readJson(req))) ?? { ok: true });
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: e.message });
      }
    }
  }

  // 앱 여부 + 버전·업데이트 상태 (hooks.info 는 main.js가 등록)
  if (pathname === "/api/logs/detect") return sendJson(res, 200, { logs: detectLogs() });
  // 리플레이 파일을 매치 정보로 (gapcheck.gg 매치와 같은 모양)
  if (pathname === "/api/replay") {
    const file = new URL(req.url, "http://x").searchParams.get("path") ?? "";
    if (!/\.(rrf|zip)$/i.test(file) || !fs.existsSync(file)) return sendJson(res, 404, { error: "리플레이 파일을 찾지 못했습니다." });
    try {
      return sendJson(res, 200, { match: loadReplay(file) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (pathname === "/api/app") return sendJson(res, 200, { app: Object.keys(hooks).length > 0, ...(hooks.info?.() ?? {}) });
  serveFile(res, PUBLIC, pathname === "/" ? "index.html" : pathname.slice(1));
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

/** 서버 시작. 127.0.0.1에만 열어서 같은 PC에서만 접속 가능. 포트가 사용 중이면 다음 번호로. 실제 포트를 돌려준다 */
async function start(opts) {
  const port = await listenPort(opts);
  watcher.start(state.logPath);
  return port;
}

async function listenPort({ waitForBasePortMs = 0 } = {}) {
  // 기본 포트가 곧 비는 경우(재실행)에는 잠깐 기다린다
  for (const until = Date.now() + waitForBasePortMs; Date.now() < until;) {
    try {
      return await listen(BASE_PORT);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  for (let port = BASE_PORT; port < BASE_PORT + 20; port++) {
    try {
      const p = await listen(port);
      console.log(`GapCheck 제어 화면: http://localhost:${p}`);
      return p;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error("사용 가능한 포트를 찾지 못했습니다.");
}

module.exports = { start, control, hooks, onChange, getState: () => state, replayDir };

if (require.main === module) {
  start().then((port) => {
    if (process.platform === "win32" && !process.env.NO_OPEN) exec(`start "" "http://localhost:${port}"`);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
//
