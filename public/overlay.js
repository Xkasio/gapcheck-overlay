// 채팅 오버레이. Electron 투명 창(main.js), 브라우저, OBS 브라우저 소스 어디서든 같은 서버 상태를 그린다.
//   OBS: http://localhost:5174/overlay.html?transparent
import { ChatView, subscribeState } from "./shared.js";

const params = new URLSearchParams(location.search);
if (params.has("transparent") || params.has("electron") || navigator.userAgent.includes("OBS/")) {
  document.body.classList.add("transparent");
}

const view = new ChatView(document.querySelector("#chat"));
let state = null;
subscribeState((s) => (state = s));

// Electron이 F7을 누르면 호출 (위치 옮기기 모드)
window.setEditMode = (on) => document.body.classList.toggle("edit", on);

function tick() {
  view.render(state);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
