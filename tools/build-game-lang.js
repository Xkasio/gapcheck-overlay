// 마인크래프트 1.16.1 언어 파일과 MCSR Ranked 모드 언어 파일에서 오버레이에 쓰는 문구만 뽑아 public/game-lang.json 을 만든다.
//   node tools/build-game-lang.js [launcherDir] [rankedJar]
// 기본 위치는 MCSRLauncher. 언어 코드는 게임의 options.txt(lang:ko_kr) 와 같다.
const fs = require("fs");
const path = require("path");
const { readZip } = require("../replay");

const LAUNCHER = process.argv[2] ?? path.join(process.env.LOCALAPPDATA, "MCSRLauncher", "launcher");
const RANKED_JAR = process.argv[3] ?? path.join(LAUNCHER, "instances", "New_Instance2", ".minecraft", "mods", "mcsrranked-6.0.4.jar");
const CLIENT_JAR = path.join(LAUNCHER, "libraries", "com", "mojang", "minecraft", "1.16.1", "minecraft-1.16.1-client.jar");
const OUT = path.join(__dirname, "..", "public", "game-lang.json");

const SEED_TYPES = ["unknown", "village", "shipwreck", "ruined_portal", "buried_treasure", "desert_temple", "jungle_temple"];
const BASTION_TYPES = ["treasure", "bridge", "stables", "housing"];
const TIMELINE = ["blind_travel", "started", "scout", "reset", "disconnect", "forfeit", "eliminate", "leave", "complete", "death", "death_spawnpoint", "dragon_death"];
// 현황 단계 순서는 shared.js 의 STAGE_EVENTS 와 같다
const STAGES = ["started", "enter_nether", "enter_bastion", "enter_fortress", "blinded", "eye_spy", "enter_end", "complete_match"];

/** "%s" / "%1$s" 를 차례대로 {이름} 자리표시자로 */
function placeholders(text, names) {
  let next = 0;
  return text.replace(/%(?:(\d)\$)?s/g, (_, n) => `{${names[n ? Number(n) - 1 : next++]}}`);
}

function vanilla(raw) {
  const titles = {};
  for (const [key, value] of Object.entries(raw)) {
    const m = key.match(/^advancements\.(.+)\.title$/);
    if (m && m[1].includes(".")) titles[m[1]] = value;
  }
  const chat = {};
  for (const kind of ["task", "goal", "challenge"]) {
    const value = raw[`chat.type.advancement.${kind}`];
    if (value) chat[kind] = placeholders(value, ["name", "title"]);
  }
  return { name: raw["language.name"], region: raw["language.region"], titles, chat };
}

function ranked(raw, code) {
  const pick = (keys, prefix, change = (v) => v, upper = false) => {
    const out = {};
    for (const k of keys) {
      const v = raw[`${prefix}${k}`];
      if (v != null) out[upper ? k.toUpperCase() : k] = change(v);
    }
    return out;
  };
  const message = (v) => {
    const text = placeholders(v, ["name", "place", "time"]);
    // 조사는 게임 채팅처럼 "이(가)"로 통일
    return code === "ko_kr" ? text.replace("{name}가 ", "{name}이(가) ") : text;
  };
  // "%s - 시작함" 의 뒷부분만 목록 이름으로 쓴다
  const label = (v) => message(v).replace(/^\{name\}\s*[-–—:：]\s*/, "");
  const stages = pick(STAGES, "projectelo.player.status.");
  const seed = pick(SEED_TYPES, "projectelo.seed_structure_type.", undefined, true);
  const bastion = pick(BASTION_TYPES, "projectelo.seed_bastion_type.", undefined, true);
  const labels = {};
  for (const k of TIMELINE) if (raw[`projectelo.timeline.${k}.compact`]) labels[k] = label(raw[`projectelo.timeline.${k}.compact`]);
  return {
    seed,
    bastion,
    bastionName: raw["projectelo.player.teleport.enter_bastion"],
    messages: pick(TIMELINE, "projectelo.timeline.", message),
    labels,
    stages,
  };
}

const index = JSON.parse(fs.readFileSync(path.join(LAUNCHER, "assets", "indexes", "1.16.json"), "utf-8")).objects;
const out = {};
for (const [key, { hash }] of Object.entries(index)) {
  const m = key.match(/^minecraft\/lang\/([a-z_]+)\.json$/);
  if (!m) continue;
  out[m[1]] = vanilla(JSON.parse(fs.readFileSync(path.join(LAUNCHER, "assets", "objects", hash.slice(0, 2), hash), "utf-8")));
}
// 영어(en_us)는 에셋에 없고 게임 jar 안에 있다
const EN = "assets/minecraft/lang/en_us.json";
out.en_us = { ...vanilla(JSON.parse(readZip(CLIENT_JAR, [EN])[EN].toString("utf8"))), name: "English", region: "United States" };

const zipNames = Object.keys(out).map((c) => `assets/mcsrranked/lang/${c}.json`);
const zipped = readZip(RANKED_JAR, zipNames);
for (const code of Object.keys(out)) {
  const data = zipped[`assets/mcsrranked/lang/${code}.json`];
  if (data) out[code].ranked = ranked(JSON.parse(data.toString("utf8")), code);
}
// 지금까지 쓰던 한국어 표기 유지
out.ko_kr.ranked.stages.complete_match = "매치 완료";

const sorted = Object.fromEntries(Object.keys(out).sort().map((c) => [c, out[c]]));
fs.writeFileSync(OUT, JSON.stringify(sorted), "utf-8");
console.log(`${Object.keys(sorted).length}개 언어, 랭크드 ${Object.values(sorted).filter((l) => l.ranked).length}개, ${Math.round(fs.statSync(OUT).size / 1024)} KB`);
