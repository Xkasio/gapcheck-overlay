import {
  BASTION, BASTION_TYPES, ChatView, SEED_TYPES, StatusView, buildEvents, buildStages, eventKind, eventName,
  fetchMatch, fmt, parseId, postJson, previewState, subscribeState, winnerUuid,
} from "./shared.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let match = null;
let playerUuid = null;
let state = null; // 서버가 보내주는 공유 상태
const previewStatus = new StatusView($("#preview-status"), 0.5);
const previewChat = new ChatView($("#preview-chat"), 0.5);
const settingsStatus = new StatusView($("#set-status"), 0.5);
const settingsChat = new ChatView($("#set-chat"), 0.5);

// ---------- 서버 상태 ----------
let first = true;
subscribeState((s) => {
  state = s;
  $("#countdown").value = String(s.countdown ?? 3);
  $("#scale").value = s.scale ?? 2;
  $("#scale-out").textContent = `${s.scale ?? 2}x`;
  // 투명도는 불투명한 정도(%)로 표시: 0% = 완전 투명
  $("#bg-opacity").value = s.bgOpacity ?? 0.5;
  $("#bg-opacity-out").textContent = `${Math.round((s.bgOpacity ?? 0.5) * 100)}%`;
  $("#chat-opacity").value = s.chatOpacity ?? 1;
  $("#chat-opacity-out").textContent = `${Math.round((s.chatOpacity ?? 1) * 100)}%`;
  $("#show-adv").checked = s.showAdvancements !== false;
  $("#keep-chat").checked = !!s.keepChat;
  $("#show-times").checked = s.showTimes !== false;
  $("#show-delta").checked = s.showDelta !== false;
  $("#auto-start").checked = s.autoStart !== false;
  $("#always-on-top").checked = s.alwaysOnTop !== false;
  renderLog(s);
  if (first) {
    first = false;
    // ?id=... 로 열면 바로 검색, 아니면 마지막으로 보던 매치 (리플레이였으면 그 파일)
    const initial = new URLSearchParams(location.search).get("id") ?? s.matchId;
    if (!new URLSearchParams(location.search).get("id") && s.replayPath) {
      openReplay(s.replayPath);
    } else if (initial) {
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

let replayPath = null; // 리플레이 파일에서 불러왔으면 그 경로 (다시 켤 때 같은 파일을 연다)

async function search(text) {
  const id = parseId(text);
  if (!id) return setStatus("올바른 ID나 gapcheck.gg/m/ID 주소를 입력하세요.", true);
  setStatus(`${id} 불러오는 중...`);
  let m;
  try {
    m = await fetchMatch(id);
  } catch (err) {
    return setStatus(`${id}: ${err.message}`, true);
  }
  replayPath = null;
  history.replaceState(null, "", `?id=${id}`);
  showMatch(m, `매치 ${id} 불러옴`);
}

/** 리플레이 파일(.rrf)에서 매치 불러오기 */
async function openReplay(file) {
  const name = file.split(/[\\/]/).pop();
  setStatus(`${name} 불러오는 중...`);
  const r = await fetch(`/api/replay?path=${encodeURIComponent(file)}`);
  const body = await r.json();
  if (!r.ok) return setStatus(`${name}: ${body.error}`, true);
  replayPath = file;
  $("#query").value = body.match.matchId ?? "";
  history.replaceState(null, "", location.pathname);
  showMatch(body.match, `리플레이 ${name} 불러옴 (매치 #${body.match.matchId})`);
}

function showMatch(m, message) {
  match = m;
  setStatus(message);
  // 같은 매치를 다시 불러온 경우 고른 플레이어 유지
  const same = state?.matchId === match.matchId && match.players.some((p) => p.uuid === state.player?.uuid);
  playerUuid = same ? state.player.uuid : winnerUuid(match);
  renderMatch();
  applySelection(same);
}

$("#open-replays").addEventListener("click", () => appAction("openReplayFolder"));
$("#browse-replay").addEventListener("click", async () => {
  const r = await appAction("browseReplay");
  if (r.ok && r.path) openReplay(r.path);
});

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
    ["시드 유형", SEED_TYPES[m.seedType] ?? m.seedType ?? "-"],
    [BASTION, BASTION_TYPES[m.bastionType] ?? m.bastionType ?? "-"],
    ["기록", fmt(m.finalTime ?? 0, 3)],
    ["날짜", (m.date ?? "").slice(0, 10)],
    ["엔드 타워", (m.endTowers ?? []).join(" · ") || "-"],
  ];
  $("#facts").innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  // 스포일러 방지: 매치를 새로 불러올 때마다 다시 숨김
  showFacts(false);

  // gapcheck.gg와 같은 구성: 오버월드/엔드(같은 시드), 네더, RNG(+ 일치율)
  const rng = m.rngSeed ?? {};
  const rngPct = rng.total ? ` <em class="pct">${Math.round((rng.matches / rng.total) * 100)}% 일치</em>` : "";
  const seeds = [["오버월드 / 엔드", m.overworldSeed, ""], ["네더", m.netherSeed, ""], ["RNG", rng.seed ?? "", rngPct]];
  $("#seeds").innerHTML = seeds
    .map(([k, v, extra]) => `<button class="seed" data-seed="${esc(v)}" title="클릭해서 복사"><span>${k}</span><code>${esc(v)}</code>${extra}</button>`)
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

function showFacts(on) {
  $("#facts").hidden = !on;
  $("#reveal").innerHTML = on
    ? "매치 정보 숨기기"
    : "매치 정보 보기";
}
$("#reveal").addEventListener("click", () => showFacts($("#facts").hidden));

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

/** 고른 플레이어/옵션으로 이벤트·현황 단계를 만들어 서버에 보냄. keepRun=true면 진행 중인 타이머 유지 */
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
    stages: buildStages(match, playerUuid),
    replayPath,
  };
  if (!keepRun) patch.startedAt = null;
  postJson("/api/state", patch);
  $("#ev-count").textContent = `${events.length}개`;
  $("#timeline").innerHTML = events
    .map(([ms, type]) => `<li class="k-${eventKind(type)}" data-ms="${ms}"><time>${fmt(ms)}</time>${esc(eventName(type))}</li>`)
    .join("");
}

// ---------- 시작 / 정지 / 설정 ----------
$("#start").addEventListener("click", () => postJson("/api/start"));
$("#stop").addEventListener("click", () => postJson("/api/stop"));
$("#countdown").addEventListener("change", (e) => postJson("/api/state", { countdown: Number(e.target.value) }));
$("#scale").addEventListener("input", (e) => postJson("/api/state", { scale: Number(e.target.value) }));
$("#bg-opacity").addEventListener("input", (e) => postJson("/api/state", { bgOpacity: Number(e.target.value) }));
$("#chat-opacity").addEventListener("input", (e) => postJson("/api/state", { chatOpacity: Number(e.target.value) }));
// 설정 창: 여는 동안 오버레이에 예시 표시, 닫으면(닫기 버튼·Esc) 원래대로
$("#open-settings").addEventListener("click", () => {
  $("#settings").showModal();
  postJson("/api/state", { preview: true });
});
$("#settings").addEventListener("close", () => postJson("/api/state", { preview: false }));
$("#show-adv").addEventListener("change", (e) => postJson("/api/state", { showAdvancements: e.target.checked }));
$("#keep-chat").addEventListener("change", (e) => postJson("/api/state", { keepChat: e.target.checked }));
$("#show-times").addEventListener("change", (e) => postJson("/api/state", { showTimes: e.target.checked }));
$("#show-delta").addEventListener("change", (e) => postJson("/api/state", { showDelta: e.target.checked }));
$("#auto-start").addEventListener("change", (e) => postJson("/api/state", { autoStart: e.target.checked }));
$("#always-on-top").addEventListener("change", (e) => postJson("/api/state", { alwaysOnTop: e.target.checked }));

// ---------- 마인크래프트 로그 ----------
function renderLog(s) {
  if (document.activeElement !== $("#log-path")) $("#log-path").value = s.logPath ?? "";
  const log = s.log;
  const el = $("#log-status");
  el.classList.toggle("ok", !!log && !log.error);
  el.classList.toggle("error", !!log?.error);
  if (!log) return void (el.textContent = "연결 안 됨");
  if (log.error) return void (el.textContent = `⚠ ${log.error}`);
  el.textContent = "● 연결됨";
}

// ...\instances\New_Instance2\.minecraft\logs\latest.log -> New_Instance2
const instanceName = (p) => p.replace(/^.*[\\/]instances[\\/]/, "").replace(/[\\/]\.?minecraft[\\/]logs[\\/]latest\.log$/, "");

async function detectLogs() {
  const { logs } = await (await fetch("/api/logs/detect")).json();
  $("#log-detected").innerHTML = `<option value="">${logs.length ? "자동으로 찾은 로그 선택…" : "찾은 로그 없음"}</option>` +
    logs.map((l) => `<option value="${esc(l.path)}">${esc(instanceName(l.path))} — ${new Date(l.mtime).toLocaleString()}</option>`).join("");
  return logs;
}
detectLogs().then((logs) => {
  // 처음 실행이면 가장 최근에 쓴 인스턴스 로그에 자동 연결
  if (!state?.logPath && logs[0]) postJson("/api/state", { logPath: logs[0].path });
});

const connectLog = (p) => postJson("/api/state", { logPath: p.trim() });
$("#log-connect").addEventListener("click", () => connectLog($("#log-path").value));
$("#log-path").addEventListener("keydown", (e) => e.key === "Enter" && connectLog(e.target.value));
$("#log-detected").addEventListener("change", (e) => e.target.value && connectLog(e.target.value));
$("#log-detect").addEventListener("click", detectLogs);
$("#log-browse").addEventListener("click", async () => {
  const r = await appAction("browseLog");
  if (r.ok && r.path) connectLog(r.path);
});

// ---------- 앱 정보 (버전, 업데이트, 단축키) ----------
let keybinds = {};

async function refreshAppInfo() {
  const info = await (await fetch("/api/app")).json();
  document.querySelectorAll(".app-only").forEach((el) => (el.hidden = !info.app));
  document.querySelectorAll(".browser-only").forEach((el) => (el.hidden = info.app));
  if (info.version) $("#version").textContent = `v${info.version}`;
  renderUpdate(info.update);
  renderAdmin(info);
  if (info.keybinds && !capturing) setKeybinds(info.keybinds);
}
refreshAppInfo();
setInterval(refreshAppInfo, 10000);

// 새 버전이 있으면 한 줄 안내 + 버튼. 버튼: 설치판은 바로 설치(받는 중이면 다 받은 뒤), 포터블은 다운로드 페이지
function renderUpdate(u) {
  const el = $("#update");
  const has = ["downloading", "ready", "available"].includes(u?.status);
  el.hidden = !has;
  if (!has) return;
  const label = u.installing ? "업데이트 중…" : "최신버전으로 업데이트";
  const html = `최신버전이 있습니다. <button id="install-update" class="primary"${u.installing ? " disabled" : ""}>${label}</button>`;
  if (el.innerHTML !== html) el.innerHTML = html;
  el.dataset.url = u.url ?? "";
}
// 관리자 권한 경고 (닫으면 이번 실행 동안은 다시 안 띄움)
let adminDismissed = false;
try { adminDismissed = sessionStorage.getItem("adminDismissed") === "1"; } catch { /* 저장소 막힘 */ }
function renderAdmin(info) {
  $("#admin-warning").hidden = !info.app || info.admin !== false || adminDismissed;
}
$("#relaunch-admin").addEventListener("click", async () => {
  setStatus("관리자 권한으로 다시 실행합니다. Windows 확인 창에서 '예'를 누르세요.");
  await appAction("relaunchAsAdmin");
});
$("#dismiss-admin").addEventListener("click", () => {
  adminDismissed = true;
  try { sessionStorage.setItem("adminDismissed", "1"); } catch { /* 저장소 막힘 */ }
  $("#admin-warning").hidden = true;
});

$("#update").addEventListener("click", (e) => {
  if (e.target.id !== "install-update") return;
  if (e.currentTarget.dataset.url) return void window.open(e.currentTarget.dataset.url);
  appAction("installUpdate").then(refreshAppInfo);
});

async function appAction(name, body) {
  const r = await (await postJson(`/api/app/${name}`, body)).json();
  if (!r.ok) setStatus(r.message ?? "실패했습니다.", true);
  return r;
}

$("#edit-overlay").addEventListener("click", async () => {
  const r = await appAction("editOverlay");
  if (r.ok) setStatus(r.editing ? "현황 창과 채팅 창을 각각 드래그해서 옮긴 뒤 버튼이나 단축키를 다시 누르세요." : "현황·채팅 위치를 고정했습니다.");
});

// ---------- 단축키 지정 ----------
const KEY_ACTIONS = [
  ["start", "시작 / 재시작"],
  ["stop", "정지"],
  ["editOverlay", "오버레이 위치 옮기기"],
  ["toggleAdvancements", "채팅 발전 과제 켜기/끄기"],
  ["toggleKeepChat", "채팅 유지 켜기/끄기"],
];
let capturing = null; // 키 입력을 기다리는 동작 이름

function setKeybinds(k) {
  keybinds = k;
  $("#keybinds").innerHTML = KEY_ACTIONS.map(([action, label]) => `
    <li data-action="${action}" class="${capturing === action ? "capturing" : ""}">
      <span>${label}</span>
      <kbd>${capturing === action ? "키를 누르세요… (Esc 취소)" : esc(k[action] || "없음")}</kbd>
      <button data-op="set">변경</button>
      <button data-op="clear" title="단축키 없애기">✕</button>
    </li>`).join("");
  document.querySelectorAll("kbd[data-key]").forEach((el) => {
    el.textContent = k[el.dataset.key] || "없음";
  });
}

$("#keybinds").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const action = btn.closest("li").dataset.action;
  if (btn.dataset.op === "clear") return saveKeybind(action, "");
  // 지정하는 동안은 전역 단축키를 꺼서 누른 키가 동작을 실행하지 않게
  capturing = action;
  await appAction("captureKeys", { on: true });
  setKeybinds(keybinds);
});

$("#reset-keys").addEventListener("click", async () => {
  const r = await appAction("resetKeybinds");
  if (r.ok) {
    setKeybinds(r.keybinds);
    setStatus("단축키를 기본값으로 되돌렸습니다.");
  }
});

async function saveKeybind(action, accelerator) {
  capturing = null;
  const r = await appAction("setKeybind", { action, accelerator });
  if (r.keybinds) setKeybinds(r.keybinds);
  if (!r.ok) return;
  const label = KEY_ACTIONS.find(([a]) => a === action)[1];
  const gameKey = accelerator && !/^(Ctrl|Alt|Shift)\+|^F\d+$|^num/.test(accelerator);
  setStatus(!accelerator ? `${label}: 단축키 없음` : `${label}: ${accelerator}${gameKey ? " (게임에서 이 키가 안 먹히게 됩니다)" : ""}`, gameKey);
}

/** KeyboardEvent -> Electron 단축키 문자열 (예: "Ctrl+Shift+F8"). 수식키만 눌렀으면 null, 지원 안 하면 undefined */
function toAccelerator(e) {
  const code = e.code;
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) return null;
  let key;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  else {
    key = {
      Space: "Space", Tab: "Tab", Backspace: "Backspace", Enter: "Return", Insert: "Insert", Delete: "Delete",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down",
      ArrowLeft: "Left", ArrowRight: "Right", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
      Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
      NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv",
      NumpadDecimal: "numdec", NumpadEnter: "Return", Pause: "Pause", ScrollLock: "Scrolllock",
    }[code];
  }
  if (!key) return undefined;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, key].join("+");
}

document.addEventListener("keydown", (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  const action = capturing;
  if (e.code === "Escape") {
    capturing = null;
    appAction("captureKeys", { on: false });
    return setKeybinds(keybinds);
  }
  const acc = toAccelerator(e);
  if (acc === null) return; // 수식키만 누른 상태: 다음 키 기다림
  if (acc === undefined) return setStatus("이 키는 단축키로 쓸 수 없습니다. 다른 키를 누르세요.", true);
  saveKeybind(action, acc);
}, true);

// ---------- 화면 갱신 ----------
function tick() {
  const now = Date.now();
  previewStatus.render(state, now);
  previewChat.render(state, now);
  if ($("#settings").open) {
    const sample = previewState(state);
    settingsStatus.render(sample, now);
    settingsChat.render(sample, now);
  }
  const running = state?.startedAt != null;
  const t = running ? now - state.startedAt : 0;
  $("#start").textContent = running ? "↻ 재시작" : "▶ 시작";
  $("#timer").textContent = fmt(t);
  for (const li of $("#timeline").children) li.classList.toggle("passed", running && Number(li.dataset.ms) <= t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
