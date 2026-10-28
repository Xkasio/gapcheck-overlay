# GapCheck Overlay (비공식)

[gapcheck.gg](https://gapcheck.gg) 매치에서 상위 랭커의 **현황과 발전 과제를 그 시각에 맞춰** 마인크래프트 화면 위에 띄워 주는 프로그램입니다.
같은 시드를 플레이하면서 그 사람이 지금쯤 어디까지 갔는지 바로 비교할 수 있습니다.

> gapcheck.gg, MCSR Ranked, Mojang, Microsoft와 관계없는 비공식 팬 메이드 도구입니다.

## 설치

[**최신 버전 다운로드 (Releases)**](https://github.com/Xkasio/gapcheck-overlay/releases/latest)

- `GapCheck-Overlay-Setup-<버전>.exe` : 설치판 (자동 업데이트, 바탕화면 바로가기)
- `GapCheck-Overlay-Portable-<버전>.exe` : 설치 없이 바로 실행 (업데이트는 알림만)

서명되지 않은 프로그램이라 처음 실행할 때 "Windows의 PC 보호" 창이 뜰 수 있습니다. **추가 정보 → 실행**을 누르세요.

## 사용법

1. 매치 ID 또는 `https://gapcheck.gg/m/ID/ranked` 주소를 검색
2. 따라갈 플레이어 선택 (기본: 승자) · 시드를 클릭해서 복사
3. 마인크래프트에서 그 시드로 월드를 만들고 **F8**로 시작
4. 오버레이에 표시되는 것
   - **현황 줄** (계속 표시): `user  바스티온 입장  ■■■□□□□□`
     매치 시작 → 네더 입장 → 바스티온 입장 → 네더 요새 입장 → 엔드 유적 찾는 중 → 엔드 유적 발견 → 엔드 입장 → 매치 완료
   - **채팅** (켜고 끌 수 있음): `user이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다`
   - "채팅 유지"를 켜면 채팅이 10초 뒤에도 남습니다.
   - "자동 시작": 게임 로그로 매치 시작 순간(카운트다운 끝)을 감지해 타이머가 저절로 시작합니다
   - "항상 위에 표시": 끄면 오버레이가 다른 창 뒤로 갈 수 있습니다
5. **내 기록과 비교**: 마인크래프트 로그(`logs/latest.log`)를 연결하면 내 발전 과제를 실시간으로 읽어 차이를 붙입니다
   - `[3:12] user이(가) [철이 철철 넘쳐] 발전 과제를 달성했습니다 +4.9` (내가 느리면 빨강 +, 빠르면 파랑 -)
   - 로그는 MCSRLauncher·Prism·MultiMC 인스턴스에서 자동으로 찾습니다

## 단축키 (게임 중에도 동작, 제어 창에서 변경 가능)

| 기본 키 | 동작 |
|---|---|
| F8 | 시작 / 재시작 (카운트다운 포함) |
| F9 | 정지 |
| F7 | 현황·채팅 위치 옮기기 (각각 드래그 후 다시 눌러 고정) |
| 없음 | 채팅 발전 과제 켜기/끄기 |
| 없음 | 채팅 유지 켜기/끄기 |

## 개발 / 빌드

```
npm install
npm start        # 개발 실행 (start.bat 과 같음)
npm run dist     # dist/<버전>/ 에 설치판·포터블 exe, 업데이트 파일(latest.yml) 생성
```

- `main.js` Electron 진입점 (제어 창, 투명 오버레이 창, 전역 단축키, 자동 업데이트)
- `server.js` 로컬 중계 서버 (gapcheck.gg 매치 중계·캐시, 공유 상태 SSE)
- `mcwindow.js` 관리자 권한 확인 / 관리자 권한으로 다시 실행 (Windows API)
- `public/` 제어 화면·오버레이 (HTML/CSS/JS)
  - `lang-ko.js` 발전 과제 이름: 마인크래프트 1.16.1 공식 한국어
  - `lang-ranked.js` 시드 유형·바스티온·타임라인 문구: MCSR Ranked 공식 한국어
- 데이터(매치 캐시, 설정, 단축키): `%APPDATA%\GapCheck Overlay\`

글꼴: [갈무리](https://github.com/quiple/galmuri) (SIL Open Font License 1.1)
