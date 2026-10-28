// 마인크래프트 인스턴스의 logs/latest.log 를 실시간으로 읽어 "내" 발전 과제를 찾는다.
//   로그 줄 예:
//   [00:05:40] [Server thread/INFO]: user이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다
//   [00:05:36] [main/INFO]: [CHAT] user이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다   <- 다른 플레이어
//   [18:26:59] [Server thread/INFO]: user has made the advancement [Stone Age]          <- 영어
//
// 런 시작 감지 (타이머 자동 시작):
//   [WorldCreator] Match initializing...        새 매치 준비 -> 초기화, 시작 대기, "매치 중"
//   Re-activating match recording                랭크드 매치 시작(카운트다운 끝) -> 시작 (이 줄이 없는 매치는 아래 unpaused 로 시작)
//   [WorldCreator] resetting the server...       매치 중 월드 리셋 -> 타이머는 그대로(매치 시계는 계속 감), 내 기록만 초기화
//   StateOutput State: generating,0              (매치 중이 아닐 때) 새 월드 생성 -> 시작 대기
//   StateOutput State: inworld,unpaused          (랭크드가 아닌 월드) 대기 중 첫 플레이 -> 시작
//   StateOutput State: title                     타이틀 화면 -> 매치 끝
//   [CHAT] 닉네임가 매치에서 기권했습니다.        누가 기권하면 매치 끝 -> 타이머 정지
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
 * onRun("reset" | "start") — 새 매치 준비 / 런 시작
 */
class LogWatcher {
  constructor({ onAdvancement, onInfo, onRun }) {
    this.onAdvancement = onAdvancement;
    this.onInfo = onInfo;
    this.onRun = onRun;
    this.armed = false; // 새 월드/매치를 준비 중이라 다음 시작 신호를 기다리는 상태
    this.inMatch = false; // 매치 진행 중 (Match initializing 부터). 이때 월드 리셋은 새 런이 아님
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
    this.restoreRunState();
    this.onInfo({ path: file, user: this.user });
    this.timer = setInterval(() => this.poll(), 250);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.file = null;
  }

  /** 이미 진행 중인 매치 한가운데서 켜도 리셋을 새 런으로 착각하지 않도록, 기존 로그로 매치 상태를 맞춘다 */
  restoreRunState() {
    this.armed = false;
    this.inMatch = false;
    const emit = this.onRun;
    this.onRun = () => {}; // 지난 줄로는 타이머를 건드리지 않음
    try {
      const size = Math.min(this.offset, 8 * 1024 * 1024);
      const fd = fs.openSync(this.file, "r");
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, this.offset - size);
      fs.closeSync(fd);
      for (const raw of buf.toString("latin1").split("\n")) {
        // 런 감지 줄은 모두 영어라 latin1 로 읽어도 된다
        const parsed = parseLine(raw.replace(/\r$/, ""));
        if (parsed) this.detectRun(parsed.text);
      }
    } catch { /* 읽기 실패: 매치 밖으로 간주 */ }
    this.onRun = emit;
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
    if (this.detectRun(parsed.text)) return;
    const adv = parseAdvancement(parsed.text);
    if (!adv) return;
    // 내 것: 닉네임이 같거나, 닉네임을 모르면 이 PC의 서버 스레드에서 나온 줄
    const mine = this.user ? adv.player === this.user : parsed.thread.startsWith("Server thread");
    this.onAdvancement({ ...adv, mine });
  }

  /** 런 시작/초기화 줄이면 처리하고 true */
  detectRun(text) {
    if (text.startsWith("[WorldCreator] Match initializing")) {
      this.inMatch = true;
      this.armed = true;
      this.onRun("reset");
      return true;
    }
    if (text === "Re-activating match recording") {
      // 준비 후 첫 신호면 매치 시작. 준비 없이 오면(재접속 등) 매치 중으로만 표시
      if (this.armed) this.onRun("start");
      this.armed = false;
      this.inMatch = true;
      return true;
    }
    if (text.startsWith("[WorldCreator] resetting the server")) {
      if (this.inMatch) this.onRun("worldReset");
      return true;
    }
    if (text.startsWith("StateOutput State: generating")) {
      if (!this.inMatch) this.armed = true;
      return true;
    }
    // 기권(나든 상대든)하면 매치가 끝나므로 정지
    // 플레이어 채팅(<닉네임> ...)은 제외
    if (!text.startsWith("<") && (/^.+가 매치에서 기권했습니다\.?$/.test(text) || / just forfeited the match$/.test(text))) {
      this.inMatch = false;
      this.armed = false;
      this.onRun("forfeit");
      return true;
    }
    if (text === "StateOutput State: title") {
      this.inMatch = false;
      this.armed = false;
      return true;
    }
    if (this.armed && text === "StateOutput State: inworld,unpaused") {
      this.armed = false;
      this.onRun("start");
      return true;
    }
    return false;
  }
}

module.exports = { LogWatcher, detectLogs, resolveLogPath, parseLine, parseAdvancement, decodeLine };
