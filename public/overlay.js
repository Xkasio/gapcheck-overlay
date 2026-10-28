// 오버레이. Electron 투명 창(main.js), 브라우저, OBS 브라우저 소스 어디서든 같은 서버 상태를 그린다.
//   ?part=status 현황 줄만, ?part=chat 채팅만, 없으면 둘 다 (앱은 두 창으로 따로 띄워 위치를 각각 정함)
//   OBS: http://localhost:5174/overlay.html?transparent (또는 &part=status / &part=chat 로 따로)
import { ChatView, StatusView, subscribeState } from "./shared.js";

const params = new URLSearchParams(location.search);
if (params.has("transparent") || params.has("electron") || navigator.userAgent.includes("OBS/")) {
  document.body.classList.add("transparent");
}

const part = params.get("part");
document.body.classList.toggle("part-status", part === "status");
if (part === "status") document.querySelector("#chat").remove();
if (part === "chat") document.querySelector("#status").remove();
document.querySelector(".edit-hint b").textContent = { status: "현황", chat: "채팅" }[part] ?? "오버레이";

const status = part === "chat" ? null : new StatusView(document.querySelector("#status"));
const view = part === "status" ? null : new ChatView(document.querySelector("#chat"));
let state = null;
subscribeState((s) => (state = s));

// Electron이 F7을 누르면 호출 (위치 옮기기 모드)
window.setEditMode = (on) => document.body.classList.toggle("edit", on);

function tick() {
  const now = Date.now();
  status?.render(state, now);
  view?.render(state, now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
