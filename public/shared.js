// 제어 화면(index)과 오버레이(overlay)가 함께 쓰는 코드.
// 상태는 중계 서버 한 곳에 있고 /api/state/stream(SSE)으로 받는다.
import { ADVANCEMENT_TITLES, CHAT_FORMATS } from "./lang-ko.js";

const TIMELINE = "projectelo.timeline.";

// 타임라인(발전 과제가 아닌) 이벤트의 채팅 문구. {name} = 플레이어 닉네임. 조사는 게임처럼 "이(가)"
const TIMELINE_MESSAGES = {
  blind_travel: "{name}이(가) 네더에서 블라인드 했습니다.",
  death_spawnpoint: "{name}이(가) 스폰포인트 데스를 했습니다.",
  dragon_death: "{name}이(가) 엔더 드래곤을 처치했습니다.",
  forfeit: "{name}이(가) 기권했습니다.",
  reset: "{name}이(가) 리셋했습니다.",
};
const TIMELINE_LABELS = {
  blind_travel: "블라인드",
  death_spawnpoint: "스폰포인트 데스",
  dragon_death: "드래곤 처치",
  forfeit: "기권",
  reset: "리셋",
};

// 게임에서도 채팅에 안 뜨는 루트 발전 과제
const NO_CHAT = new Set(["story.root", "nether.root", "end.root", "adventure.root", "husbandry.root"]);
// 사소한 이벤트 = 발전 과제가 아닌 것 (타임라인 이벤트, 채팅에 안 뜨는 루트). 발전 과제는 전부 사소하지 않음
const isMinor = (type) => type.startsWith(TIMELINE) || NO_CHAT.has(type);

export const SEED_TYPES = {
  RUINED_PORTAL: "폐허가 된 차원문",
  DESERT_TEMPLE: "사막 사원",
  VILLAGE: "마을",
  SHIPWRECK: "난파선",
  BURIED_TREASURE: "묻힌 보물",
};
export const BASTION_TYPES = { TREASURE: "보물", HOUSING: "주거지", STABLES: "호글린 우리", BRIDGE: "다리" };

export const CHAT_LIFE_MS = 10000; // 마인크래프트 채팅처럼 10초 뒤 사라짐
const CHAT_MAX_LINES = 10;

/** 제어 화면 목록용 짧은 이름 */
export const eventName = (type) =>
  type.startsWith(TIMELINE)
    ? TIMELINE_LABELS[type.slice(TIMELINE.length)] ?? type.slice(TIMELINE.length)
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

export function buildEvents(match, uuid, hideMinor) {
  return (match.splits ?? [])
    .filter((s) => s.uuid === uuid && !(hideMinor && isMinor(s.type)))
    .map((s) => [s.time, s.type])
    .sort((a, b) => a[0] - b[0]);
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
      const text = (TIMELINE_MESSAGES[key] ?? `{name}: ${key}`).replace("{name}", name);
      msgs.push({ at: ms, parts: [[text, "c-yellow"]] });
    } else {
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

/** 마인크래프트 채팅창 모양의 오버레이. 시각이 된 메시지만 아래에서부터 쌓이고 10초 뒤 사라진다. */
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
    const key = state && JSON.stringify([state.player?.uuid, state.events?.length, state.events?.[0], state.countdown, state.startedAt]);
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
        if (age < 0 || age >= CHAT_LIFE_MS) return;
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
  }

  clear() {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
