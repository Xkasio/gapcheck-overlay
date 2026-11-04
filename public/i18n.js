// 언어 데이터.
//   시스템 언어: 제어 화면 글자 (ui-lang.json, 한국어·영어·일본어)
//   오버레이 언어: 게임에 있는 언어 전부 (game-lang.json, tools/build-game-lang.js 로 생성). 코드는 options.txt 의 lang 값과 같다
const [UI, GAME_LANG] = await Promise.all(["/ui-lang.json", "/game-lang.json"].map((url) => fetch(url).then((r) => r.json())));

export { GAME_LANG };

export const UI_TO_GAME = { ko: "ko_kr", en: "en_us", ja: "ja_jp" };

let uiLang = "ko";
export const getUiLang = () => uiLang;

/** lang 에 없는 문구는 영어로. 게임 언어 코드(ja_jp)의 앞부분(ja)을 넘겨도 되고, 문구가 없는 언어면 영어가 된다 */
export function t(key, vars, lang = uiLang) {
  const text = UI[lang]?.[key] ?? UI.en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (all, k) => vars[k] ?? all) : text;
}

/** 시스템 언어를 바꾸고 data-i18n* 표시가 붙은 글자를 다시 쓴다. 바뀌었으면 true */
export function setUiLang(lang) {
  const next = UI[lang] ? lang : "en";
  const changed = next !== uiLang;
  uiLang = next;
  document.documentElement.lang = next;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  return changed;
}
