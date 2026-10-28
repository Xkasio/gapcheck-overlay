// GapCheck 로컬 중계 서버
//   node server.js   ->  http://localhost:5174 (브라우저 제어 화면만)
//   npm start        ->  main.js(Electron)가 이 서버를 띄우고 제어 창 + 투명 오버레이 창을 연다
//
// 하는 일
// 1. 브라우저는 gapcheck.gg에 직접 요청할 수 없으므로(다른 주소에서 오면 403) 대신 가져온다.
//    받은 매치는 ../data/matches/{id}.json 에 캐시한다.
// 2. 제어 화면 / 오버레이 창 / OBS 가 같은 상태(매치, 플레이어, 시작 시각)를 보도록
//    상태를 여기 한 곳에 두고 SSE(/api/state/stream)로 실시간 전달한다.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const BASE_PORT = Number(process.env.PORT) || 5174;
const PUBLIC = path.join(__dirname, "public");
// 배포판(Electron)은 main.js가 사용자 폴더(AppData)로 지정한다
const DATA = process.env.GAPCHECK_DATA || path.join(__dirname, "..", "data");
const CACHE = path.join(DATA, "matches");
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
// { matchId, seedType, player:{uuid,nickname,rank,elo}, events:[[ms,type]], startedAt, countdown, scale }
let state = { events: [], startedAt: null, countdown: 3, scale: 2 };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")), startedAt: null };
} catch { /* 처음 실행 */ }

const clients = new Set();
// Electron이 등록하는 동작 (브라우저로만 실행하면 비어 있음)
const hooks = {};

function setState(patch) {
  state = { ...state, ...patch };
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, startedAt: null }), "utf-8");
}

const control = {
  start: () => state.events.length && setState({ startedAt: Date.now() + (Number(state.countdown) || 0) * 1000 }),
  stop: () => setState({ startedAt: null }),
};

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
        setState(await readJson(req));
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
        return sendJson(res, 200, (await hooks[hook[1]]()) ?? { ok: true });
      } catch (e) {
        return sendJson(res, 500, { ok: false, message: e.message });
      }
    }
  }

  // 앱 여부 + 버전·업데이트 상태 (hooks.info 는 main.js가 등록)
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
async function start() {
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

module.exports = { start, control, hooks };

if (require.main === module) {
  start().then((port) => {
    if (process.platform === "win32" && !process.env.NO_OPEN) exec(`start "" "http://localhost:${port}"`);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
