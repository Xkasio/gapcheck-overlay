import {
  ChatView, StatusView, bastionLabel, bastionTypeName, buildEvents, buildStages, eventKind, eventName,
  fetchMatch, fmt, parseId, postJson, previewState, seedTypeName, subscribeState, viewNow, winnerUuid,
} from "./shared.js";
import { GAME_LANG, getUiLang, setUiLang, t } from "./i18n.js";

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
  if (setUiLang(s.uiLang) || first) renderLanguage();
  renderOverlayLang(s);
  $("#ui-lang").value = getUiLang();
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

// ---------- 언어 ----------
/** 시스템 언어가 바뀌면 코드로 그린 글자를 다시 그린다 (data-i18n 표시는 setUiLang 이 바꿈) */
function renderLanguage() {
  renderCountdownOptions();
  renderStatus();
  setKeybinds(keybinds);
  detectLogs();
  renderUpdate(lastUpdate);
  if (match) {
    renderMatch();
    applySelection(true);
  }
}

function renderCountdownOptions() {
  $("#countdown").innerHTML = [0, 3, 5, 10]
    .map((n) => `<option value="${n}">${esc(n ? t("settings.seconds", { n }) : t("settings.countdownNone"))}</option>`)
    .join("");
}

const langName = (code) => {
  const l = GAME_LANG[code];
  return l ? `${l.name ?? code}${l.region ? ` (${l.region})` : ""}` : code;
};
// 게임에 있는 언어 전부. 게임 언어와 동일이 맨 위
const OVERLAY_LANGS = Object.keys(GAME_LANG).sort((a, b) => langName(a).localeCompare(langName(b)));
let overlayLangKey = null;

function renderOverlayLang(s) {
  const chosen = s.overlayLang ?? "game";
  const key = `${getUiLang()}:${s.gameLang}`;
  if (key !== overlayLangKey) {
    overlayLangKey = key;
    const current = s.gameLang ? langName(s.gameLang) : t("settings.overlayLangUnknown");
    $("#overlay-lang").innerHTML = `<option value="game">${esc(t("settings.overlayLangGame", { lang: current }))}</option>` +
      OVERLAY_LANGS.map((code) => `<option value="${code}">${esc(langName(code))}</option>`).join("");
  }
  $("#overlay-lang").value = chosen;
  $("#overlay-lang-hint").hidden = chosen !== "game" || !!s.gameLang;
}

$("#ui-lang").addEventListener("change", (e) => postJson("/api/state", { uiLang: e.target.value }));
$("#overlay-lang").addEventListener("change", (e) => postJson("/api/state", { overlayLang: e.target.value }));

// ---------- 검색 ----------
$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  search($("#query").value);
});

let replayPath = null; // 리플레이 파일에서 불러왔으면 그 경로 (다시 켤 때 같은 파일을 연다)

async function search(text) {
  const id = parseId(text);
  if (!id) return setStatus("search.invalid", null, true);
  setStatus("search.loading", { name: id });
  let m;
  try {
    m = await fetchMatch(id);
  } catch (err) {
    return setStatus("search.failed", { name: id, message: err.message }, true);
  }
  replayPath = null;
  history.replaceState(null, "", `?id=${id}`);
  showMatch(m, "search.loadedMatch", { id });
}

/** 리플레이 파일(.rrf)에서 매치 불러오기 */
async function openReplay(file) {
  const name = file.split(/[\\/]/).pop();
  setStatus("search.loading", { name });
  const r = await fetch(`/api/replay?path=${encodeURIComponent(file)}`);
  const body = await r.json();
  if (!r.ok) return setStatus("search.failed", { name, message: body.error }, true);
  replayPath = file;
  $("#query").value = body.match.matchId ?? "";
  history.replaceState(null, "", location.pathname);
  showMatch(body.match, "search.loadedReplay", { name, id: body.match.matchId });
}

function showMatch(m, message, vars) {
  match = m;
  setStatus(message, vars);
  // 같은 매치를 다시 불러온 경우 고른 플레이어 유지
  const same = state?.matchId === match.matchId && match.players.some((p) => p.uuid === state.player?.uuid);
  playerUuid = same ? state.player.uuid : winnerUuid(match);
  renderMatch();
  // 스포일러 방지: 매치를 새로 불러올 때마다 다시 숨김
  showFacts(false);
  applySelection(same);
}

$("#browse-replay").addEventListener("click", async () => {
  const r = await appAction("browseReplay");
  if (r.ok && r.path) openReplay(r.path);
});

// 지금 상태 줄. 시스템 언어를 바꾸면 다시 쓴다
let status = { key: "search.prompt", vars: null, error: false };

function setStatus(key, vars = null, error = false) {
  status = { key, vars, error };
  renderStatus();
}

function renderStatus() {
  $("#status").textContent = t(status.key, status.vars);
  $("#status").classList.toggle("error", status.error);
}

// ---------- 매치 정보 ----------
function renderMatch() {
  const m = match;
  $("#main").hidden = false;
  $("#m-id").textContent = `#${m.matchId}`;
  const facts = [
    [t("match.seedType"), m.seedType ? seedTypeName(m.seedType) : "-"],
    [bastionLabel(), m.bastionType ? bastionTypeName(m.bastionType) : "-"],
    [t("match.record"), fmt(m.finalTime ?? 0, 3)],
    [t("match.date"), (m.date ?? "").slice(0, 10)],
    [t("match.endTowers"), (m.endTowers ?? []).join(" · ") || "-"],
  ];
  $("#facts").innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  showFacts(!$("#facts").hidden);

  // gapcheck.gg와 같은 구성: 오버월드/엔드(같은 시드), 네더, RNG(+ 일치율)
  const rng = m.rngSeed ?? {};
  const rngPct = rng.total ? ` <em class="pct">${esc(t("seed.match", { pct: Math.round((rng.matches / rng.total) * 100) }))}</em>` : "";
  const seeds = [[t("seed.overworldEnd"), m.overworldSeed, ""], [t("seed.nether"), m.netherSeed, ""], ["RNG", rng.seed ?? "", rngPct]];
  $("#seeds").innerHTML = seeds
    .map(([k, v, extra]) => `<button class="seed" data-seed="${esc(v)}" title="${esc(t("seed.copyTitle"))}"><span>${esc(k)}</span><code>${esc(v)}</code>${extra}</button>`)
    .join("");

  const winner = m.result?.uuid;
  $("#players").innerHTML = m.players
    .map((p) => `
      <button class="player" data-uuid="${p.uuid}">
        <img src="https://mc-heads.net/avatar/${p.uuid}/40" alt="" width="40" height="40">
        <span class="p-name">${esc(p.nickname)}${p.uuid === winner ? ` <em class="win">${esc(t("player.win"))}</em>` : ""}</span>
        <span class="p-rank">${esc(t("player.rank"))} <b>#${p.eloRank ?? "-"}</b></span>
        <span class="p-elo">Elo <b>${p.elo ?? "-"}</b></span>
      </button>`)
    .join("");
}

function showFacts(on) {
  $("#facts").hidden = !on;
  $("#reveal").textContent = t(on ? "match.hide" : "match.show");
}
$("#reveal").addEventListener("click", () => showFacts($("#facts").hidden));

$("#seeds").addEventListener("click", async (e) => {
  const btn = e.target.closest(".seed");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.seed);
    setStatus("seed.copied", { name: btn.querySelector("span").textContent });
  } catch {
    setStatus("seed.copyBlocked", null, true);
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
  $("#ev-count").textContent = t("timeline.count", { n: events.length });
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
document.querySelectorAll(".open-settings").forEach((btn) => btn.addEventListener("click", () => {
  $("#settings").showModal();
  postJson("/api/state", { preview: true });
}));
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
  if (!log) return void (el.textContent = t("log.disconnected"));
  if (log.error) return void (el.textContent = `⚠ ${t(log.error)}`);
  el.textContent = t("log.connected");
}

// ...\instances\New_Instance2\.minecraft\logs\latest.log -> New_Instance2
const instanceName = (p) => p.replace(/^.*[\\/]instances[\\/]/, "").replace(/[\\/]\.?minecraft[\\/]logs[\\/]latest\.log$/, "");

async function detectLogs() {
  const { logs } = await (await fetch("/api/logs/detect")).json();
  $("#log-detected").innerHTML = `<option value="">${esc(t(logs.length ? "log.detectedSelect" : "log.detectedNone"))}</option>` +
    logs.map((l) => `<option value="${esc(l.path)}">${esc(instanceName(l.path))} — ${new Date(l.mtime).toLocaleString(getUiLang())}</option>`).join("");
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
let lastUpdate = null;
function renderUpdate(u) {
  lastUpdate = u;
  const el = $("#update");
  const has = ["downloading", "ready", "available"].includes(u?.status);
  el.hidden = !has;
  if (!has) return;
  const label = t(u.installing ? "update.installing" : "update.install");
  const html = `${esc(t("update.available"))} <button id="install-update" class="primary"${u.installing ? " disabled" : ""}>${label}</button>`;
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
  setStatus("admin.relaunching");
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
  if (!r.ok) setStatus(r.message ?? "common.failed", null, true);
  return r;
}

$("#edit-overlay").addEventListener("click", async () => {
  const r = await appAction("editOverlay");
  if (r.ok) setStatus(r.editing ? "move.editing" : "move.locked");
});

// ---------- 단축키 지정 ----------
const KEY_ACTIONS = ["start", "stop", "editOverlay", "toggleAdvancements", "toggleKeepChat"];
let capturing = null; // 키 입력을 기다리는 동작 이름

function setKeybinds(k) {
  keybinds = k;
  $("#keybinds").innerHTML = KEY_ACTIONS.map((action) => `
    <li data-action="${action}" class="${capturing === action ? "capturing" : ""}">
      <span>${esc(t(`keys.${action}`))}</span>
      <kbd>${esc(capturing === action ? t("keys.capture") : k[action] || t("common.none"))}</kbd>
      <button data-op="set">${esc(t("keys.change"))}</button>
      <button data-op="clear" title="${esc(t("keys.clearTitle"))}">✕</button>
    </li>`).join("");
  document.querySelectorAll("kbd[data-key]").forEach((el) => {
    el.textContent = k[el.dataset.key] || t("common.none");
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
    setStatus("keys.resetDone");
  }
});

async function saveKeybind(action, accelerator) {
  capturing = null;
  const r = await appAction("setKeybind", { action, accelerator });
  if (r.keybinds) setKeybinds(r.keybinds);
  if (!r.ok) return;
  const label = t(`keys.${action}`);
  const gameKey = accelerator && !/^(Ctrl|Alt|Shift)\+|^F\d+$|^num/.test(accelerator);
  setStatus(!accelerator ? "keys.cleared" : gameKey ? "keys.setGameKey" : "keys.set", { label, key: accelerator }, gameKey);
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
  if (acc === undefined) return setStatus("keys.unsupported", null, true);
  saveKeybind(action, acc);
}, true);

// ---------- 화면 갱신 ----------
function tick() {
  const now = viewNow(state);
  previewStatus.render(state, now);
  previewChat.render(state, now);
  if ($("#settings").open) {
    const sample = previewState(state);
    settingsStatus.render(sample);
    settingsChat.render(sample);
  }
  const running = state?.startedAt != null;
  const elapsed = running ? now - state.startedAt : 0;
  $("#start").textContent = t(running ? "control.restart" : "control.start");
  $("#timer").textContent = fmt(elapsed);
  for (const li of $("#timeline").children) li.classList.toggle("passed", running && Number(li.dataset.ms) <= elapsed);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
