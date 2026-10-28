// MCSR Ranked 리플레이(.rrf)를 매치 정보로 바꾼다.
// .rrf 는 zip 파일이고 안에 meta.json(시드, 플레이어, 결과)과 timelines.json(발전 과제·타임라인)이 있다.
// 결과는 gapcheck.gg 매치와 같은 모양이라 화면·오버레이가 그대로 쓴다.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/** zip 에서 원하는 파일만 꺼낸다 (저장 방식: 그대로 또는 deflate) */
function readZip(file, wanted) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    // zip 으로 시작하는데 끝(목록)이 없으면 덜 받아졌거나 손상된 파일
    throw new Error(buf.readUInt32LE(0) === 0x04034b50
      ? "리플레이 파일이 손상됐거나 덜 받아졌습니다."
      : "리플레이 파일(.rrf)이 아닙니다.");
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!wanted.includes(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
  }
  return out;
}

function loadReplay(file) {
  const files = readZip(file, ["meta.json", "timelines.json"]);
  if (!files["meta.json"]) throw new Error("meta.json 이 없습니다. 마인크래프트 랭크드 리플레이 파일인지 확인하세요.");
  const m = JSON.parse(files["meta.json"].toString("utf8"));
  const timelines = files["timelines.json"] ? JSON.parse(files["timelines.json"].toString("utf8")) : [];
  return {
    matchId: m.matchId,
    replayFile: path.basename(file),
    date: m.date ? new Date(m.date).toISOString() : null,
    overworldSeed: String(m.overworldSeed ?? ""),
    netherSeed: String(m.netherSeed ?? ""),
    endSeed: String(m.theEndSeed ?? m.overworldSeed ?? ""),
    // 리플레이에는 RNG 시드가 없어서 오버월드 시드로 대신한다
    rngSeed: { seed: String(m.overworldSeed ?? "") },
    seedType: m.seedType ?? null,
    bastionType: m.bastionType ?? null,
    endTowers: [],
    players: (m.players ?? []).map((pl) => ({ uuid: pl.uuid, nickname: pl.nickname, eloRank: pl.eloRank ?? null, elo: pl.eloRate ?? null })),
    result: m.result ?? null,
    finalTime: m.result?.time ?? null,
    splits: timelines.map((t) => ({ uuid: t.uuid, type: t.type, time: t.time })),
  };
}

module.exports = { loadReplay };
