// 마인크래프트 인스턴스의 logs/latest.log 를 실시간으로 읽어 "내" 발전 과제를 찾는다.
//   로그 줄 예:
//   [00:05:40] [Server thread/INFO]: user이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다
//   [00:05:36] [main/INFO]: [CHAT] user이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다   <- 다른 플레이어
//   [18:26:59] [Server thread/INFO]: user has made the advancement [Stone Age]          <- 영어
//   (게임에 있는 언어 전부를 game-lang.json 의 형식으로 읽는다)
//
// 게임 언어: 인스턴스의 options.txt "lang:ko_kr" 를 보고, 게임에서 언어를 바꿔 파일이 바뀌면 다시 읽는다.
//   로그에는 언어 코드가 따로 남지 않지만, 발전 과제 줄의 언어가 options.txt 와 다르면 로그 쪽을 따른다
//   (StandardSettings 처럼 파일과 다른 언어를 적용하는 모드가 있다).
//
// 런 시작 감지 (타이머 자동 시작):
//   [WorldCreator] Match initializing...        새 매치 준비 -> 초기화, 시작 대기, "매치 중"
//   Re-activating match recording                랭크드 매치 시작(카운트다운 끝) -> 시작 (이 줄이 없는 매치는 아래 unpaused 로 시작)
//   [WorldCreator] resetting the server...       매치 중 월드 리셋 -> 타이머는 그대로(매치 시계는 계속 감), 내 기록만 초기화
//   StateOutput State: generating,0              (매치 중이 아닐 때) 새 월드 생성 -> 시작 대기
//   StateOutput State: inworld,unpaused          (랭크드가 아닌 월드) 대기 중 첫 플레이 -> 시작
//   StateOutput State: title                     타이틀 화면 -> 매치 끝
//   [CHAT] 닉네임가 매치에서 기권했습니다.        상대가 기권하면 매치 끝 -> 타이머 정지
//   [WorldCreator] leaving the server...         매치 중 서버를 떠남(내 기권 등, 리셋 제외) -> 타이머 정지
//
// 내 완주 감지 (완주 전용 로그 줄은 없다):
//   내 [엔드 해방] 발전 과제 뒤 첫 "Stopping worker threads"   엔드 출구 포털로 차원이 바뀐 순간 = 완주 -> 타이머 멈춤
//   ("Saving and pausing game..." 은 Esc 일시정지에도 남아서 쓰지 않는다)
//   (드래곤 처치 약 10초 뒤로, 랭크드 공식 기록과 같은 시점. 그 전에 서버를 떠나면 그때 완주로 본다)
const fs = require("fs");
const path = require("path");
const os = require("os");

const GAME_LANG = require("./public/game-lang.json");
const EN = GAME_LANG.en_us;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 언어별 발전 과제 제목 -> 발전 과제 id (story.smelt_iron 등). 번역이 없는 제목은 게임처럼 영어로 나온다
const TITLE_TO_TYPE = {};
// 채팅 형식 -> 정규식과 그 형식을 쓰는 언어들. 글자가 많은(구체적인) 형식부터 맞춰 본다
const formats = new Map();
for (const [code, lang] of Object.entries(GAME_LANG)) {
  TITLE_TO_TYPE[code] = new Map(Object.entries({ ...EN.titles, ...lang.titles }).map(([type, title]) => [title, type]));
  for (const format of Object.values({ ...EN.chat, ...lang.chat })) {
    if (!formats.has(format)) {
      const source = format.split(/(\{name\}|\{title\})/).map((s) => (s === "{name}" ? "(.+?)" : s === "{title}" ? "\\[(.+)\\]" : escapeRe(s))).join("");
      formats.set(format, { re: new RegExp(`^${source}$`), nameFirst: format.indexOf("{name}") < format.indexOf("{title}"), langs: [] });
    }
    if (!formats.get(format).langs.includes(code)) formats.get(format).langs.push(code);
  }
}
const ADVANCEMENT_LINES = [...formats.entries()]
  .sort(([a], [b]) => b.length - a.length)
  .map(([, line]) => line);

// 상대가 기권한 채팅 줄 (랭크드 모드에 번역이 있는 언어 전부)
const FORFEIT_LINES = [...new Set(Object.values(GAME_LANG).map((l) => l.ranked?.messages?.forfeit).filter((f) => f?.includes("{name}")))]
  .map((f) => new RegExp(`^${f.split("{name}").map(escapeRe).join(".+")}$`));
const isForfeit = (text) => !text.startsWith("<") && (/^.+가 매치에서 기권했습니다\.?$/.test(text) || FORFEIT_LINES.some((re) => re.test(text)));

// 로그는 UTF-8 이거나 Windows 시스템 인코딩이다. UTF-8 이 아니면 게임 문구를 알아볼 수 있는 인코딩을 찾아 기억해 둔다
const utf8 = new TextDecoder("utf-8", { fatal: true });
const legacy = ["euc-kr", "shift_jis", "gbk", "big5", "windows-1251", "windows-1252", "windows-1250", "windows-1253", "windows-1254", "windows-1255", "windows-1256", "windows-1257", "windows-1258", "windows-874"]
  .flatMap((name) => {
    try {
      return [new TextDecoder(name)];
    } catch {
      return []; // 이 런타임에 없는 인코딩
    }
  });
function decodeLine(buf) {
  try {
    return utf8.decode(buf);
  } catch { /* 시스템 인코딩 */ }
  for (const [i, decoder] of legacy.entries()) {
    const text = decoder.decode(buf);
    const parsed = parseLine(text.replace(/\r$/, ""));
    if (parsed && (parseAdvancement(parsed.text) || isForfeit(parsed.text))) {
      legacy.unshift(...legacy.splice(i, 1));
      return text;
    }
  }
  return legacy[0].decode(buf);
}

/** "[시각] [스레드/INFO]: 내용" -> { thread, text } */
function parseLine(line) {
  const m = line.match(/^\[[\d:]+\] \[([^\]]+)\/INFO\]: (?:\[CHAT\] )?(.*)$/);
  if (!m) return null;
  return { thread: m[1], text: m[2].replace(/§./g, "").trim() };
}

/** 발전 과제 줄이면 { player, title, type, langs }. langs: 이 줄을 이렇게 쓰는 언어들 (en_us·en_gb 처럼 같은 문구를 쓰는 언어가 있다) */
function parseAdvancement(text, preferLang) {
  if (!text.includes("[")) return null;
  for (const { re, nameFirst, langs } of ADVANCEMENT_LINES) {
    const m = text.match(re);
    if (!m) continue;
    const [player, title] = nameFirst ? [m[1], m[2]] : [m[2], m[1]];
    const matched = langs.filter((code) => TITLE_TO_TYPE[code].has(title));
    if (!matched.length) continue;
    const lang = matched.includes(preferLang) ? preferLang : matched[0];
    return { player, title, type: TITLE_TO_TYPE[lang].get(title), langs: matched };
  }
  return null;
}

/** options.txt 의 게임 언어 코드 (없으면 null) */
function readOptionsLang(file) {
  try {
    return fs.readFileSync(file, "utf-8").match(/^lang:(\S+)/m)?.[1].toLowerCase() ?? null;
  } catch {
    return null;
  }
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
 * onGameLang(code | null) — 게임 언어 (ko_kr 등)
 */
class LogWatcher {
  constructor({ onAdvancement, onInfo, onRun, onGameLang }) {
    this.onAdvancement = onAdvancement;
    this.onInfo = onInfo;
    this.onRun = onRun;
    this.onGameLang = onGameLang;
    this.gameLang = null;
    this.armed = false; // 새 월드/매치를 준비 중이라 다음 시작 신호를 기다리는 상태
    this.inMatch = false; // 매치 진행 중 (Match initializing 부터). 이때 월드 리셋은 새 런이 아님
    this.resetting = false; // 월드 리셋 중 (resetting the server ~ leaving the server)
    this.finishing = false; // 내가 드래곤을 잡고 엔딩 화면을 기다리는 중
    this.file = null;
    this.timer = null;
  }

  start(input) {
    this.stop();
    const file = resolveLogPath(input);
    if (!file) {
      if (input) this.onInfo({ path: input, error: "log.notFound" });
      else this.onInfo(null);
      this.setGameLang(null);
      return;
    }
    this.file = file;
    this.offset = fs.statSync(file).size;
    this.rest = Buffer.alloc(0);
    this.user = this.readUser();
    this.restoreRunState();
    this.onInfo({ path: file, user: this.user });
    this.timer = setInterval(() => this.poll(), 250);
    // logs\latest.log 와 같은 인스턴스의 options.txt
    this.optionsFile = path.join(path.dirname(path.dirname(file)), "options.txt");
    this.optionsMtime = null;
    this.checkOptions();
    this.optionsTimer = setInterval(() => this.checkOptions(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.optionsTimer);
    this.timer = null;
    this.file = null;
  }

  setGameLang(code) {
    if (code === this.gameLang) return;
    this.gameLang = code;
    this.onGameLang?.(code);
  }

  /** options.txt 가 바뀌었으면(게임에서 언어 변경) 게임 언어를 다시 읽는다 */
  checkOptions() {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.optionsFile).mtimeMs;
    } catch { /* 없음: 언어를 모르는 상태 */ }
    if (mtime === this.optionsMtime) return;
    this.optionsMtime = mtime;
    this.setGameLang(readOptionsLang(this.optionsFile));
  }

  /** 이미 진행 중인 매치 한가운데서 켜도 리셋을 새 런으로 착각하지 않도록, 기존 로그로 매치 상태를 맞춘다 */
  restoreRunState() {
    this.armed = false;
    this.inMatch = false;
    this.resetting = false;
    this.finishing = false;
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
    const { text } = parsed;
    if (this.finishing && (text === "Stopping worker threads" || text.startsWith("[WorldCreator] leaving the server") || text === "StateOutput State: title")) {
      this.finishing = false;
      this.onRun("finish");
    }
    if (this.detectRun(text)) return;
    const adv = parseAdvancement(text, this.gameLang);
    if (!adv) return;
    if (!adv.langs.includes(this.gameLang)) this.setGameLang(adv.langs[0]);
    // 내 것: 닉네임이 같거나, 닉네임을 모르면 이 PC의 서버 스레드에서 나온 줄
    const mine = this.user ? adv.player === this.user : parsed.thread.startsWith("Server thread");
    if (mine && adv.type === "end.kill_dragon") this.finishing = true;
    this.onAdvancement({ ...adv, mine });
  }

  /** 런 시작/초기화 줄이면 처리하고 true */
  detectRun(text) {
    // 새 매치·월드 리셋이면 드래곤을 잡았어도 완주가 아니다
    if (text.startsWith("[WorldCreator] Match initializing") || text.startsWith("[WorldCreator] resetting the server")) this.finishing = false;
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
      this.resetting = true; // 리셋도 "leaving the server" 를 남기므로 매치를 떠난 것과 구분
      if (this.inMatch) this.onRun("worldReset");
      return true;
    }
    // 내가 기권하면 채팅 줄 없이 바로 서버를 떠난다. 매치 중에 (리셋이 아닌데) 떠나면 매치 끝 -> 정지
    if (text.startsWith("[WorldCreator] leaving the server")) {
      if (this.inMatch && !this.resetting) {
        this.inMatch = false;
        this.armed = false;
        this.onRun("forfeit");
      }
      this.resetting = false;
      return true;
    }
    if (text.startsWith("StateOutput State: generating")) {
      if (!this.inMatch) this.armed = true;
      return true;
    }
    // 기권(나든 상대든)하면 매치가 끝나므로 정지
    // 플레이어 채팅(<닉네임> ...)은 제외
    if (isForfeit(text)) {
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
