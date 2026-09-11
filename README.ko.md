# Seen · X 열람 기록

**언어 / Languages:** [简体中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Seen은 데스크톱 Chrome/Edge용 Manifest V3 확장 프로그램입니다. X(구 Twitter)에서 실제로 읽은 게시물을 브라우저에 로컬 저장하고, X 오른쪽에 고정되는 패널이나 독립 기록 페이지에서 검색하고 필터링할 수 있습니다.

빠르게 갱신되는 X 타임라인에서는 방금 본 게시물을 다시 찾기 어렵습니다. Seen은 X API, 추가 계정, 외부 서버를 사용하지 않으며 열람 데이터를 업로드하지 않습니다.

## 주요 기능

- 게시물의 50% 이상이 보이고 설정된 체류 시간(0.8 / 1 / 1.5 / 2초)을 충족할 때만 기록합니다.
- 일반 게시물, 긴 글, 인용, 이미지, 동영상/GIF, X 아티클을 지원합니다.
- 백그라운드, 포커스 해제, DM·Grok·설정 페이지에서는 수집을 일시 중지합니다.
- 본문, 작성자, 사용자명, 인용문, 아티클 제목/요약을 검색합니다.
- 전체, 텍스트, 이미지, 동영상/GIF, 아티클 필터를 제공합니다.
- 사용자 지정 열람 시간 범위와 오늘·최근 7일·최근 30일 빠른 선택을 지원합니다.
- 패널은 오른쪽 열에 맞춰 표시되고 탐색 중 자동 갱신됩니다. 변경이 없으면 불필요한 재렌더링을 하지 않습니다.
- 작성자 이름은 프로필로, 원문 링크는 원 게시물로 이동합니다. 아티클은 표지·제목·요약 카드로, 이미지는 원래 비율로 표시합니다.
- 독립 페이지에서 정렬, 페이지 추가 로드, 개별/일괄 삭제, 수집 중지, JSON 백업, 라이트/다크/시스템 테마를 제공합니다.

## 기술과 동작 방식

TypeScript, Manifest V3, Dexie 4/IndexedDB, esbuild, Node.js 테스트 러너, IntersectionObserver, MutationObserver, `requestIdleCallback`, Web Worker를 사용합니다.

콘텐츠 스크립트가 `article[data-testid="tweet"]`에서 게시물 정보를 추출하고 보이는 비율과 체류 시간을 감시합니다. 조건을 충족한 이벤트는 Service Worker가 묶어서 IndexedDB에 저장합니다. 검색에는 정규화된 텍스트, 작성자 인덱스, n-gram, 안정적인 커서가 사용됩니다. 인라인 패널은 3초마다 상태를 확인하며 `history-changed` 알림도 수신합니다.

## 개인정보 보호

데이터는 현재 브라우저 프로필의 IndexedDB에만 저장됩니다. 원격 API, 분석, 계정, 업로드 기능이 없습니다. 미디어 URL은 `https://pbs.twimg.com`으로 제한하고, 가져온 데이터는 검증한 뒤 이스케이프하여 표시합니다.

## 설치

Node.js 18+, Chrome 116+ 또는 호환되는 Edge가 필요합니다.

```bash
git clone https://github.com/DescLee/x-you-have-seen.git
cd x-you-have-seen
npm install
npm run build
```

`chrome://extensions`(Edge는 `edge://extensions`)를 열고 개발자 모드를 켠 뒤 **압축해제된 확장 프로그램을 로드**에서 `dist/`를 선택합니다. `x.com`과 `twitter.com` 접근을 허용하고 X 페이지를 새로 고칩니다.

```bash
npm run package
```

`release/seen-0.1.0.zip`과 SHA-256 파일을 생성합니다.

## 개발 및 검증

```bash
npm run typecheck
npm test
npm run check
npm run package
```

가시성, 체류 시간, 중복 병합, 다국어 검색, 미디어/아티클 카드, 날짜 필터, 페이지네이션, 가져오기/내보내기, 정리, 보안 경계를 테스트합니다. 브라우저 스크립트는 `scripts/qa-*.js`에 있습니다.

## 알려진 제한

- 데스크톱 X 페이지용이며 모바일 X는 지원 범위가 아닙니다.
- X DOM이 변경되면 `src/extract.ts`의 선택자를 업데이트해야 할 수 있습니다.
- 이미지와 아티클 표지는 접근 가능한 `pbs.twimg.com` URL에 의존합니다.
- 기록은 브라우저 프로필별로 저장되며 기기 간 동기화되지 않습니다.

## 라이선스

이 프로젝트는 [Apache License 2.0](LICENSE)에 따라 배포됩니다. Copyright 2026 DescLee.

라이선스 조건에 따라 상업적 목적을 포함한 사용, 수정 및 재배포가 허용됩니다. 재배포할 때는 해당 권리 고지를 유지하고 라이선스 사본을 포함하며 수정한 파일에 변경 사실을 표시해야 합니다. 자세한 내용은 [LICENSE](LICENSE)와 [NOTICE](NOTICE)를 참고하세요. 타사 의존성에는 각각의 라이선스가 적용됩니다.
