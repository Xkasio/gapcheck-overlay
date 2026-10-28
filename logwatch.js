// 마인크래프트 인스턴스의 logs/latest.log 를 실시간으로 읽어 "내" 발전 과제를 찾는다.
//   로그 줄 예:
//   [00:05:40] [Server thread/INFO]: chomchome이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다
//   [00:05:36] [main/INFO]: [CHAT] dusue이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다   <- 다른 플레이어
//   [18:26:59] [Server thread/INFO]: chomchome has made the advancement [Stone Age]          <- 영어
// 로그 인코딩은 인스턴스마다 UTF-8 이거나 CP949(한국어 Windows 기본) 라서 줄마다 판별한다.
const fs = require("fs");
const path = require("path");
const os = require("os");

// 브라우저용 lang-*.js 는 `export const NAME = {JSON};` 형태라 JSON 부분만 읽어 쓴다
function loadExport(file, name) {
  const text = fs.readFileSync(path.join(__dirname, "public", file), "utf-8");
  const m = text.match(new RegExp(`export const ${name} = (\\{[\\s\\S]*?\\n\\});`));
  return JSON.parse(m[1]);
}

// 발전 과제 제목(한국어/영어) -> 발전 과제 id (story.smelt_iron 등)
const TITLE_TO_TYPE = new Map();
for (const [file, name] of [["lang-ko.js", "ADVANCEMENT_TITLES"], ["lang-en.js", "ADVANCEMENT_TITLES_EN"]]) {
  for (const [type, title] of Object.entries(loadExport(file, name))) TITLE_TO_TYPE.set(title, type);
}

const ADVANCEMENT_LINE = [
  /^(.+?)이\(가\) \[(.+)\] (?:발전 과제를 달성했습니다|목표를 달성했습니다|도전을 완료했습니다)$/,
  /^(.+?) has (?:made the advancement|reached the goal|completed the challenge) \[(.+)\]$/,
];

const utf8 = new TextDecoder("utf-8", { fatal: true });
const cp949 = new TextDecoder("euc-kr");
function decodeLine(buf) {
  try {
    return utf8.decode(buf);
  } catch {
    return cp949.decode(buf);
  }
}

/** "[시각] [스레드/INFO]: 내용" -> { thread, text } */
function parseLine(line) {
  const m = line.match(/^\[[\d:]+\] \[([^\]]+)\/INFO\]: (?:\[CHAT\] )?(.*)$/);
  if (!m) return null;
  return { thread: m[1], text: m[2].replace(/§./g, "").trim() };
}

/** 발전 과제 줄이면 { player, title, type } */
function parseAdvancement(text) {
  for (const re of ADVANCEMENT_LINE) {
    const m = text.match(re);
    if (m) return { player: m[1], title: m[2], type: TITLE_TO_TYPE.get(m[2]) ?? null };
  }
  return null;
}

/** 인스턴스 폴더나 로그 파일 경로 -> latest.log 경로 (없으면 null) */
function resolveLogPath(input) {
  if (!input) return null;
  const p = input.trim().replace(/^"|"$/g, "");
  const candidates = [p, path.join(p, "latest.log"), path.join(p, "logs", "latest.log"),
    path.join(p, ".minecraft", "logs", "latest.log"), path.join(p, "minecraft", "logs", "latest.log")];
  return candidates.find((c) => c.endsWith(".log") && fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** 알려진 런처 위치에서 latest.log 찾기. 최근에 바뀐 순 */
function detectLogs() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const instanceRoots = [
    path.join(local, "MCSRLauncher", "launcher", "instances"),
    path.join(roaming, "PrismLauncher", "instances"),
    path.join(roaming, "PolyMC", "instances"),
    path.join(roaming, "MultiMC", "instances"),
    "C:\\MultiMC\\instances",
  ];
  const found = [path.join(roaming, ".minecraft", "logs", "latest.log")];
  for (const root of instanceRoots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) found.push(path.join(root, n, ".minecraft", "logs", "latest.log"), path.join(root, n, "minecraft", "logs", "latest.log"));
  }
  return found
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * latest.log 를 따라 읽는다. 새로 붙은 줄만 본다 (켜기 전 기록은 무시).
 * onAdvancement({ player, title, type, mine }) — mine: 이 PC의 플레이어 것인지
 * onInfo({ path, user, error }) — 연결 상태
 */
class LogWatcher {
  constructor({ onAdvancement, onInfo }) {
    this.onAdvancement = onAdvancement;
    this.onInfo = onInfo;
    this.file = null;
    this.timer = null;
  }

  start(input) {
    this.stop();
    const file = resolveLogPath(input);
    if (!file) {
      if (input) this.onInfo({ path: input, error: "latest.log 를 찾지 못했습니다." });
      else this.onInfo(null);
      return;
    }
    this.file = file;
    this.offset = fs.statSync(file).size;
    this.rest = Buffer.alloc(0);
    this.user = this.readUser();
    this.onInfo({ path: file, user: this.user });
    this.timer = setInterval(() => this.poll(), 250);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.file = null;
  }

  /** 게임을 켤 때 남는 "Setting user: 닉네임" 으로 내 닉네임을 알아낸다 */
  readUser() {
    try {
      const fd = fs.openSync(this.file, "r");
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return buf.subarray(0, n).toString("latin1").match(/Setting user: (\S+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  poll() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // 게임 재시작 중 잠깐 없을 수 있음
    }
    if (size < this.offset) {
      // 게임을 다시 켜서 latest.log 가 새로 시작됨
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size === this.offset) return;
    const fd = fs.openSync(this.file, "r");
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;

    let data = Buffer.concat([this.rest, buf]);
    let nl;
    while ((nl = data.indexOf(0x0a)) !== -1) {
      this.handleLine(decodeLine(data.subarray(0, nl)).replace(/\r$/, ""));
      data = data.subarray(nl + 1);
    }
    this.rest = data;
  }

  handleLine(line) {
    if (!this.user) {
      const u = line.match(/Setting user: (\S+)/)?.[1];
      if (u) {
        this.user = u;
        this.onInfo({ path: this.file, user: u });
      }
    }
    const parsed = parseLine(line);
    if (!parsed) return;
    const adv = parseAdvancement(parsed.text);
    if (!adv) return;
    // 내 것: 닉네임이 같거나, 닉네임을 모르면 이 PC의 서버 스레드에서 나온 줄
    const mine = this.user ? adv.player === this.user : parsed.thread.startsWith("Server thread");
    this.onAdvancement({ ...adv, mine });
  }
}

module.exports = { LogWatcher, detectLogs, resolveLogPath, parseLine, parseAdvancement, decodeLine };
