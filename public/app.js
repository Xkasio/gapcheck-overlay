import {
  BASTION_TYPES, ChatView, SEED_TYPES, buildEvents, eventKind, eventName, fetchMatch, fmt,
  parseId, postJson, subscribeState, winnerUuid,
} from "./shared.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let match = null;
let playerUuid = null;
let state = null; // 서버가 보내주는 공유 상태
const preview = new ChatView($("#preview"), 0.5);

// ---------- 서버 상태 ----------
let first = true;
subscribeState((s) => {
  state = s;
  $("#countdown").value = String(s.countdown ?? 3);
  $("#scale").value = s.scale ?? 2;
  $("#scale-out").textContent = `${s.scale ?? 2}x`;
  if (first) {
    first = false;
    // ?id=... 로 열면 바로 검색, 아니면 마지막으로 보던 매치
    const initial = new URLSearchParams(location.search).get("id") ?? s.matchId;
    if (initial) {
      $("#query").value = initial;
      search(String(initial));
    }
  }
});

// ---------- 검색 ----------
$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  search($("#query").value);
});

async function search(text) {
  const id = parseId(text);
  if (!id) return setStatus("올바른 ID나 gapcheck.gg/m/ID 주소를 입력하세요.", true);
  setStatus(`${id} 불러오는 중...`);
  try {
    match = await fetchMatch(id);
  } catch (err) {
    return setStatus(`${id}: ${err.message}`, true);
  }
  setStatus(`매치 ${id} 불러옴`);
  history.replaceState(null, "", `?id=${id}`);
  // 같은 매치를 다시 불러온 경우 고른 플레이어 유지
  const same = state?.matchId === match.matchId && match.players.some((p) => p.uuid === state.player?.uuid);
  playerUuid = same ? state.player.uuid : winnerUuid(match);
  renderMatch();
  applySelection(same);
}

function setStatus(text, error = false) {
  $("#status").textContent = text;
  $("#status").classList.toggle("error", error);
}

// ---------- 매치 정보 ----------
function renderMatch() {
  const m = match;
  $("#main").hidden = false;
  $("#m-id").textContent = `#${m.matchId}`;
  const facts = [
    ["시드 유형", SEED_TYPES[m.seedType] ?? m.seedType],
    ["보루 잔해", BASTION_TYPES[m.bastionType] ?? m.bastionType ?? "-"],
    ["기록", fmt(m.finalTime ?? 0, 3)],
    ["날짜", (m.date ?? "").slice(0, 10)],
    ["엔드 타워", (m.endTowers ?? []).join(" · ") || "-"],
  ];
  $("#facts").innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");

  const seeds = [["오버월드", m.overworldSeed], ["네더", m.netherSeed], ["엔드", m.endSeed]];
  $("#seeds").innerHTML = seeds
    .map(([k, v]) => `<button class="seed" data-seed="${esc(v)}" title="클릭해서 복사"><span>${k}</span><code>${esc(v)}</code></button>`)
    .join("");

  const winner = m.result?.uuid;
  $("#players").innerHTML = m.players
    .map((p) => `
      <button class="player" data-uuid="${p.uuid}">
        <img src="https://mc-heads.net/avatar/${p.uuid}/40" alt="" width="40" height="40">
        <span class="p-name">${esc(p.nickname)}${p.uuid === winner ? ' <em class="win">승리</em>' : ""}</span>
        <span class="p-rank">랭크 <b>#${p.eloRank ?? "-"}</b></span>
        <span class="p-elo">Elo <b>${p.elo ?? "-"}</b></span>
      </button>`)
    .join("");
}

$("#seeds").addEventListener("click", async (e) => {
  const btn = e.target.closest(".seed");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.seed);
    setStatus(`${btn.querySelector("span").textContent} 시드를 복사했습니다.`);
  } catch {
    setStatus("클립보드 복사가 막혀 있습니다. 시드를 직접 선택해 복사하세요.", true);
  }
});

$("#players").addEventListener("click", (e) => {
  const btn = e.target.closest(".player");
  if (!btn) return;
  playerUuid = btn.dataset.uuid;
  applySelection(false);
});

$("#hide-minor").addEventListener("change", () => applySelection(true));

/** 고른 플레이어/옵션으로 이벤트 목록을 만들어 서버에 보냄. keepRun=true면 진행 중인 타이머 유지 */
function applySelection(keepRun) {
  if (!match) return;
  document.querySelectorAll(".player").forEach((b) => b.classList.toggle("selected", b.dataset.uuid === playerUuid));
  const p = match.players.find((x) => x.uuid === playerUuid);
  const events = buildEvents(match, playerUuid, $("#hide-minor").checked);
  const patch = {
    matchId: match.matchId,
    seedType: match.seedType,
    player: { uuid: p.uuid, nickname: p.nickname, rank: p.eloRank, elo: p.elo },
    events,
  };
  if (!keepRun) patch.startedAt = null;
  postJson("/api/state", patch);
  $("#ev-count").textContent = `${events.length}개`;
  $("#timeline").innerHTML = events
    .map(([ms, type]) => `<li class="k-${eventKind(type)}" data-ms="${ms}"><time>${fmt(ms)}</time>${esc(eventName(type))}</li>`)
    .join("");
}

// ---------- 시작 / 정지 / 설정 ----------
const start = () => postJson("/api/start");
const stop = () => postJson("/api/stop");

$("#start").addEventListener("click", start);
$("#stop").addEventListener("click", stop);
document.addEventListener("keydown", (e) => {
  if (e.key === "F8") { e.preventDefault(); start(); }
  if (e.key === "F9") { e.preventDefault(); stop(); }
});
// 앱(Electron)으로 실행했을 때만 전체화면/오버레이 위치 버튼 표시
fetch("/api/app").then((r) => r.json()).then(({ app }) => {
  document.querySelectorAll(".app-only").forEach((el) => (el.hidden = !app));
  document.querySelectorAll(".browser-only").forEach((el) => (el.hidden = app));
});

async function appAction(name) {
  const r = await (await postJson(`/api/app/${name}`)).json();
  if (!r.ok) return setStatus(r.message ?? "실패했습니다.", true);
  if (name === "fullscreen") {
    setStatus(r.mode === "borderless" ? `${r.title}: 전체화면(테두리 없음)으로 바꿨습니다.` : `${r.title}: 창 모드로 되돌렸습니다.`);
  } else {
    setStatus(r.editing ? "오버레이를 드래그해서 옮긴 뒤 F7이나 버튼을 다시 누르세요." : "오버레이 위치를 고정했습니다.");
  }
}
$("#fullscreen").addEventListener("click", () => appAction("fullscreen"));
$("#edit-overlay").addEventListener("click", () => appAction("editOverlay"));

$("#countdown").addEventListener("change", (e) => postJson("/api/state", { countdown: Number(e.target.value) }));
$("#scale").addEventListener("input", (e) => postJson("/api/state", { scale: Number(e.target.value) }));

// ---------- 화면 갱신 ----------
function tick() {
  const now = Date.now();
  preview.render(state, now);
  const running = state?.startedAt != null;
  const t = running ? now - state.startedAt : 0;
  $("#start").textContent = running ? "↻ 재시작" : "▶ 시작";
  $("#timer").textContent = fmt(t);
  for (const li of $("#timeline").children) li.classList.toggle("passed", running && Number(li.dataset.ms) <= t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
