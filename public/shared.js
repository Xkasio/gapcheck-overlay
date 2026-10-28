// 제어 화면(index)과 오버레이(overlay)가 함께 쓰는 코드.
// 상태는 중계 서버 한 곳에 있고 /api/state/stream(SSE)으로 받는다.
// 용어: 발전 과제 이름은 마인크래프트 공식 한국어(lang-ko.js), 그 밖의 용어·타임라인 문구는 MCSR Ranked 공식 한국어(lang-ranked.js)
import { ADVANCEMENT_TITLES, CHAT_FORMATS } from "./lang-ko.js";
import { BASTION, BASTION_TYPES, SEED_TYPES, TIMELINE_LABELS, TIMELINE_MESSAGES } from "./lang-ranked.js";

export { BASTION, BASTION_TYPES, SEED_TYPES };

const TIMELINE = "projectelo.timeline.";

// 게임에서도 채팅에 안 뜨는 루트 발전 과제
const NO_CHAT = new Set(["story.root", "nether.root", "end.root", "adventure.root", "husbandry.root"]);
// 사소한 이벤트 = 발전 과제가 아닌 것 (타임라인 이벤트, 채팅에 안 뜨는 루트). 발전 과제는 전부 사소하지 않음
const isMinor = (type) => type.startsWith(TIMELINE) || NO_CHAT.has(type);

export const CHAT_LIFE_MS = 10000; // 마인크래프트 채팅처럼 10초 뒤 사라짐
const CHAT_MAX_LINES = 10;

// 현황 단계. 오버레이 맨 위에 계속 표시되고, 매치 기록의 아래 이벤트 시각에 맞춰 바뀐다
export const STAGES = ["매치 시작", "네더 입장", "바스티온 입장", "네더 요새 입장", "엔드 유적 찾는 중", "엔드 유적 발견", "엔드 입장", "매치 완료"];
const STAGE_EVENTS = {
  "story.enter_the_nether": 1,
  "nether.find_bastion": 2,
  "nether.find_fortress": 3,
  "projectelo.timeline.blind_travel": 4,
  "story.follow_ender_eye": 5,
  "story.enter_the_end": 6,
};
const DONE = STAGES.length - 1;

const fill = (text, name) => text.replace("{name}", name).replace(/\{place\}|\{time\}/g, "?");

/** 제어 화면 목록용 짧은 이름 */
export const eventName = (type) =>
  type.startsWith(TIMELINE)
    ? fill(TIMELINE_LABELS[type.slice(TIMELINE.length)] ?? type.slice(TIMELINE.length), "")
    : `[${ADVANCEMENT_TITLES[type] ?? type}]`;

// story / nether / end / projectelo -> CSS 색 클래스
export const eventKind = (type) => {
  const head = type.split(".")[0];
  return ["story", "nether", "end", "projectelo"].includes(head) ? head : "other";
};

export function fmt(ms, decimals = 1) {
  const sign = ms < 0 ? "-" : "";
  const total = Math.abs(ms) / 1000;
  const m = Math.floor(total / 60);
  const s = (total - m * 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0");
  return `${sign}${m}:${s}`;
}

export function parseId(text) {
  const m = String(text).match(/\/m\/(\d+)/) || String(text).trim().match(/^(\d+)$/);
  return m ? m[1] : null;
}

export async function fetchMatch(id) {
  const r = await fetch(`/api/match/${id}`);
  if (r.status === 404) throw new Error("없는 매치입니다.");
  if (!r.ok) throw new Error("gapcheck.gg에서 불러오지 못했습니다. 중계 서버 창을 확인하세요.");
  return (await r.json()).match;
}

export const winnerUuid = (match) => match.result?.uuid ?? match.players?.[0]?.uuid;

/** 따라가는 플레이어의 이벤트 [ms, type] 를 시간순으로 */
export function buildEvents(match, uuid, hideMinor) {
  return (match.splits ?? [])
    .filter((s) => s.uuid === uuid && !(hideMinor && isMinor(s.type)))
    .map((s) => [s.time, s.type])
    .sort((a, b) => a[0] - b[0]);
}

/** 현황 단계 [ms, 단계 index] 를 시간순으로. 같은 단계는 처음 도달한 시각만 */
export function buildStages(match, uuid) {
  const first = new Map([[0, 0]]);
  for (const s of match.splits ?? []) {
    const idx = STAGE_EVENTS[s.type];
    if (s.uuid === uuid && idx != null && !(first.get(idx) <= s.time)) first.set(idx, s.time);
  }
  // 매치 완료는 승자만 (공식 기록 = 드래곤 처치 후 약 10초). 진 사람은 매치가 먼저 끝나므로 마지막 단계에 머문다
  const done = match.result?.uuid === uuid ? match.result.time ?? match.finalTime : null;
  if (done != null) first.set(DONE, done);
  return [...first].map(([idx, ms]) => [ms, idx]).sort((a, b) => a[0] - b[0]);
}

/** 서버 상태 구독. 끊기면 EventSource가 알아서 다시 연결한다. */
export function subscribeState(onState) {
  const es = new EventSource("/api/state/stream");
  es.onmessage = (e) => onState(JSON.parse(e.data));
  return es;
}

export const postJson = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

// ---------- 채팅 메시지 ----------
// 메시지 = { at: 시작 기준 ms, parts: [[text, colorClass]] }
function chatMessages(state) {
  const name = state.player?.nickname ?? "?";
  const msgs = [];
  // 카운트다운: 1초마다 한 줄씩 (예: 3초 → 3, 2, 1, 시작!)
  for (let k = state.countdown ?? 0; k > 0; k--) {
    const text = k === state.countdown ? `[GapCheck] ${name}의 타임라인 시작까지 ${k}초` : `[GapCheck] ${k}초`;
    msgs.push({ at: -k * 1000, parts: [[text, "c-gray"]] });
  }
  msgs.push({ at: 0, parts: [[`[GapCheck] 시작! (${name} #${state.player?.rank ?? "-"})`, "c-green"]] });

  for (const [ms, type] of state.events ?? []) {
    if (NO_CHAT.has(type)) continue;
    if (type.startsWith(TIMELINE)) {
      const key = type.slice(TIMELINE.length);
      msgs.push({ at: ms, parts: [[fill(TIMELINE_MESSAGES[key] ?? `{name}: ${key}`, name), "c-yellow"]] });
    } else if (state.showAdvancements !== false) {
      // "%s이(가) %s 발전 과제를 달성했습니다" -> 이름(흰색) + [제목](초록)
      const [before, middle, after] = CHAT_FORMATS.task.split("%s");
      msgs.push({
        at: ms,
        parts: [[before, ""], [name, ""], [middle, ""], [`[${ADVANCEMENT_TITLES[type] ?? type}]`, "c-green"], [after, ""]],
      });
    }
  }
  return msgs;
}

/** 현황 줄. 시작 후 계속 떠 있고, 단계가 바뀌면 잠깐 반짝인다. 매치 완료면 시간이 멈춘다 */
export class StatusView {
  constructor(root, zoom = 1) {
    root.classList.add("mc-status");
    root.innerHTML = `<span class="st-name"></span><span class="st-stage"></span><span class="st-bar">${"<i></i>".repeat(STAGES.length)}</span><span class="st-time"></span>`;
    this.root = root;
    this.zoom = zoom;
    this.el = {
      name: root.querySelector(".st-name"),
      stage: root.querySelector(".st-stage"),
      bar: [...root.querySelectorAll(".st-bar i")],
      time: root.querySelector(".st-time"),
    };
    this.lastKey = null;
  }

  render(state, now = Date.now()) {
    const t = state?.startedAt != null ? now - state.startedAt : -1;
    const stages = state?.stages ?? [];
    this.root.hidden = t < 0 || !stages.length;
    if (this.root.hidden) {
      this.lastKey = null;
      return;
    }
    this.root.style.setProperty("--scale", (state.scale ?? 2) * this.zoom);

    let cur = stages[0];
    const reached = new Set();
    for (const st of stages) {
      if (st[0] > t) break;
      cur = st;
      reached.add(st[1]);
    }
    const [ms, idx] = cur;
    const key = `${state.startedAt}:${idx}`;
    if (key !== this.lastKey) {
      // 단계 색: 네더(1~3) 주황, 엔드 유적~엔드(4~6) 보라, 완료 초록
      this.root.dataset.tone = idx === DONE ? "done" : idx >= 4 ? "end" : idx >= 1 ? "nether" : "start";
      this.el.name.textContent = `${state.player?.nickname ?? "?"} #${state.player?.rank ?? "-"}`;
      this.el.stage.textContent = STAGES[idx];
      this.el.bar.forEach((i, n) => i.classList.toggle("on", reached.has(n)));
      if (this.lastKey) {
        this.root.classList.remove("flash");
        void this.root.offsetWidth;
        this.root.classList.add("flash");
      }
      this.lastKey = key;
    }
    this.el.time.textContent = fmt(idx === DONE ? ms : t);
  }
}

/** 마인크래프트 채팅창 모양의 오버레이. 시각이 된 메시지만 아래에서부터 쌓이고 10초 뒤 사라진다 (keepChat이면 계속 남음). */
export class ChatView {
  /** zoom: 미리보기처럼 작은 곳에 그릴 때 state.scale 에 곱할 배율 */
  constructor(root, zoom = 1) {
    root.classList.add("chat");
    this.root = root;
    this.zoom = zoom;
    this.cacheKey = null;
    this.msgs = [];
    this.nodes = new Map(); // 메시지 index -> 줄 element
  }

  render(state, now = Date.now()) {
    this.root.style.setProperty("--scale", (state?.scale ?? 2) * this.zoom);
    // 재시작하면 줄을 처음부터 다시 쌓도록 startedAt 도 키에 넣는다
    const key = state && JSON.stringify([state.player?.uuid, state.events?.length, state.events?.[0], state.countdown, state.startedAt, state.showAdvancements]);
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.msgs = state ? chatMessages(state) : [];
      this.clear();
    }

    const visible = [];
    if (state?.startedAt != null) {
      const t = now - state.startedAt;
      this.msgs.forEach((msg, i) => {
        const age = t - msg.at;
        if (age < 0) return;
        if (state.keepChat) return visible.push([i, 1]);
        if (age >= CHAT_LIFE_MS) return;
        // 마인크래프트 공식: 마지막 1초 동안 흐려짐
        const a = Math.min(1, Math.max(0, (1 - age / CHAT_LIFE_MS) * 10));
        visible.push([i, a * a]);
      });
    }

    const keep = new Set(visible.slice(-CHAT_MAX_LINES).map(([i]) => i));
    for (const [i, node] of this.nodes) {
      if (!keep.has(i)) {
        node.remove();
        this.nodes.delete(i);
      }
    }
    for (const [i, opacity] of visible.slice(-CHAT_MAX_LINES)) {
      let node = this.nodes.get(i);
      if (!node) {
        node = document.createElement("div");
        node.className = "chat-line";
        for (const [text, cls] of this.msgs[i].parts) {
          const span = document.createElement("span");
          span.textContent = text;
          if (cls) span.className = cls;
          node.append(span);
        }
        this.root.append(node); // 메시지는 시간순이라 항상 맨 아래에 붙는다
        this.nodes.set(i, node);
      }
      node.style.opacity = opacity;
    }
    // 채팅 칸이 꽉 차면 위로 넘친 줄이 반쯤 잘려 보이므로, 다 안 들어가는 줄은 숨긴다
    for (const node of this.nodes.values()) node.style.visibility = node.offsetTop < 0 ? "hidden" : "";
  }

  clear() {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
