# Project Instructions

## Session Startup

Run and review:

- `pwd`
- `git log --oneline -10`

After reviewing:

- Explore the codebase
- Propose a short implementation plan
- Wait for approval before implementation

---

## Architecture

- `apps/web/` — React + Vite の SPA。**本番（`aruku.pages.dev`）が配信しているのはこれ**。範囲と移植元との対応は `apps/web/PORTING.md`
  - `src/features/` — 画面（home, search, picker, loading, result, settings, error）
  - `src/state/` — アプリの状態（zustand の store）。`src/navigation/` — ルート表とガード
  - `src/places/` `src/search/` `src/location/` — 地点検索・経路検索の配線・現在地
  - `src/map/` `src/layout/` `src/shared/` `src/theme/` `src/i18n/` — 地図・レイアウト・共有部品・デザイントークン・文言
- `packages/engine/` — 経路エンジン（**TypeScript**）。挙動の正本は `docs/spec/route-optimization.md`
- `functions/` — Cloud Functions **TypeScript** backend. Google Places / Routes proxies (`placesProxy`, `googleWalkProxy`, `googleWalkMatrixProxy`) + Firestore rate limiter. **公共交通のプロキシは無い** — Transit API はクライアント直叩き（`docs/spec/route-optimization.md` §2.1）
- Flutter 版は #387 で撤去した。`flutter-final` タグと `archive/flutter` ブランチに残る（復元手順は `docs/archive/flutter-restore.md`）。コメントの `flutter-final:lib/...` はそのタグ内のパス
- Run the app: `npm --prefix apps/web run dev`. Setup: see README.

### Navigation

- react-router のルート表（`apps/web/src/navigation/router.tsx`）とガード（`apps/web/src/navigation/guard.ts` の `resolveRedirect`）が画面遷移の権威。deep link・ブラウザ履歴・アプリ内遷移はすべてガードを通る。
- アプリ内遷移は store の `go(Screen.x, update)`。
- 画面と表示前提データ（loading↔routePhase、result↔route、error↔routeErrorKind）は**必ず同じ `go()` の `update` で**更新する（ガードの前提）。

---

## Core Workflow

IMPORTANT:

- Implement only ONE feature per session
- Follow TDD
- Commit in small logical units
- When writing version tags for external tools (GitHub Actions, Node, npm packages, etc.), **always fetch the latest version via WebSearch before writing**. Never rely on training-data knowledge for version numbers.

NEVER:

- Commit with failing tests
- Modify unrelated files
- Add dependencies without approval
- Commit directly to `main`

---

## Validation Commands

Before every commit, run:

- `python3 .claude/doc_consistency.py --staged`（index を検査する。commit フックも同じ検査を走らせる）

When `packages/engine/` changes, also run in `packages/engine/`:

- `npx tsc --noEmit`
- `npm test`

When `functions/` changes, also run in `functions/`:

- `npm run build`  (tsc)
- `npm test`       (vitest)

When `apps/web/` changes, also run in `apps/web/`:

- `npx tsc --noEmit`
- `npm test`
- `npx vite build`
- `npm run e2e`   (Playwright)

`npm run e2e` は自分でビルドしてプレビューを起こすので、`npx vite build` とは別に走らせる。
初回だけブラウザの取得が要る（`npx playwright install chromium`）。

---

## Security Restrictions

NEVER access:

- `.env`（`apps/web/.env` を含む）

---

## Additional Rules

@.codex/docs/workflow.md
@.codex/docs/web-conventions.md
@.codex/docs/testing.md
