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

- `apps/web/` — React + Vite の SPA。**本番（`aruku.pages.dev`）が配信しているのはこれ**
  - `src/features/` — 画面（home, search, picker, loading, result, settings, error）
  - `src/state/` — アプリの状態（zustand の store）。`src/navigation/` — ルート表とガード
  - `src/places/` `src/search/` `src/location/` — 地点検索・経路検索の配線・現在地
  - `src/map/` `src/layout/` `src/shared/` `src/theme/` `src/i18n/` — 地図・レイアウト・共有部品・デザイントークン・文言
  - `src/bench/` — 厳密走査の A/B 計測（#462）を回す開発時だけの画面。`npm run dev` 中に `/bench.html` で開く。本番のルート表にも配信物にも入らない
    - `src/bench/replay/` — Transit の応答を録画し、同じ応答・同じ遅延で再生して版どうしを比べる Node のハーネス（#504）。`node scripts/replay.mjs` で走らせる。手順は `docs/ops/replay-bench.md`
- `packages/engine/` — 経路エンジン（**TypeScript**）
- `functions/` — Cloud Functions **TypeScript** backend. Google Places / Routes proxies (`placesProxy`, `googleWalkProxy`, `googleWalkMatrixProxy`) + Firestore rate limiter + ODPT の GTFS と mini-tokyo-3d の時刻表から時刻表パックを作る定期関数（`refreshTimetablePacks`・`src/timetable-pack/`）+ そのパックで1回乗車の徒歩最大を厳密に求めるエンドポイント（`exactWalkMax`・`src/exact-walk-max.ts`） + 乗車駅→降車駅の発着をパックから返すエンドポイント（`rideDepartures`・`src/ride-departures.ts`）. **公共交通のプロキシは無い** — Transit API はクライアント直叩き
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

## Where to Write What

真実の置き場所は **コード・テスト・コミットログ** の3つだけにする（#528）。コメントとドキュメントは
コードが変わっても追従されずに腐り、古い記述は判断を誤らせるので、書かない。

| 場所 | 書くこと | 具体例 |
| --- | --- | --- |
| コード | **How** — どう実現しているか | 命名・構造・型で語る |
| テストコード | **What** — 何を満たすべきか | テスト名が仕様書になるように書く |
| コミットログ | **Why / Why not** — なぜこの変更か、なぜ他の方法を採らなかったか | 背景・制約・罠・見送った代替案。issue番号と紐づける |

IMPORTANT:

- **コードコメントを書かない**（`packages/engine`・`apps/web`・`functions` の `.ts` `.tsx` `.mjs` `.cjs`）
- **Markdown を足さない**。置いてよいのは `README.md`・`CLAUDE.md`・`AGENTS.md`・`.claude/`・`.codex/`・
  `.agents/` の指示ファイル・`docs/ops/`・`docs/security_hardening.md`・`docs/archive/flutter-restore.md` だけ
- 「なぜこう書いていないのか」を残したくなったら、コミットメッセージに書く。コードから読めない罠は、
  それを踏むテストを書いて名前で語る
- 残した文書（`README.md`・`docs/ops/`・`docs/security_hardening.md`）が説明する挙動・手順を変えたら、
  同じコミットで直す。分けた時点で「後で」になり、実際には直らない（#357）
- 消したコメント・文書は `pre-comment-purge` タグから `git show pre-comment-purge:<path>` で引ける

例外（ツールが読むので消すと挙動が変わるもの）:

- `// oxlint-disable-next-line <rule>`・`eslint-disable*`・`// @ts-expect-error`・`/// <reference ... />`・
  `/* @vite-ignore */`・`// @vitest-environment <env>`・shebang
- `.mjs` / `.cjs` の型だけの JSDoc（`@type`・`@param`・`@returns`・`@typedef`・`@property`・`@template`・`@satisfies`。説明文は書かない）
- 設定ファイル（`*.config.*`・JSON・yml など）と、生成物 `packages/engine/src/services/station-coord-table.ts`（ライセンス表記を持つ）

検査は `functions/scripts/repo-policy/`（`npm --prefix functions run lint:policy`）。CI の `repo-policy` ジョブ、
commit 前のフック（`.claude/repo_policy.py`）、編集時のフック（`.claude/typecheck_on_edit.py`）が同じものを走らせる。
**検査に引っかかったら、コメントや Markdown を消すこと。** 許可リストを広げるのは、ツールが読むものを
足すときだけ。

---

## Validation Commands

Before every commit, run:

- `npm --prefix functions run lint:policy`（コメントと許可外の Markdown の検査。commit フックも同じ検査を走らせる）

When `packages/engine/` changes, also run in `packages/engine/`:

- `npx tsc --noEmit`
- `npm test`
- `npm run lint`

When `functions/` changes, also run in `functions/`:

- `npm run build`  (tsc)
- `npm test`       (vitest)
- `npm run lint`   (oxlint)

When `apps/web/` changes, also run in `apps/web/`:

- `npx tsc --noEmit`
- `npm test`
- `npm run lint`
- `npx vite build`
- `npm run e2e`   (Playwright)

`npm run e2e` は自分でビルドしてプレビューを起こすので、`npx vite build` とは別に走らせる。
初回だけブラウザの取得が要る（`npx playwright install chromium`）。

Lint（oxlint + tsgolint）の規則はルートの `.oxlintrc.json` に置き、各パッケージが extends する。
規則は error / off の二値で、警告は使わない。違反は既定で直す。規則が正しいのに書き方を崩せない
行だけ、`// oxlint-disable-next-line <rule>` で抑止し、抑止した理由はコミットメッセージに書く（使われない
抑止はそれ自体がエラーになる）。

依存の向き（engine → web / functions の禁止、web の本番コード → `src/bench` の禁止、循環 import の
禁止）は dependency-cruiser が検査する。規則はルートの `.dependency-cruiser.cjs`、走らせるのは
`npm --prefix functions run lint:deps`（3パッケージのどれを変えても走らせる）。

未使用のファイル・export・依存は knip が検査する。設定はルートの `knip.jsonc`、走らせるのは
ルートで `npm ci` したうえでの `npm run knip`（3パッケージのどれを変えても走らせる）。

書式は Prettier が揃える。設定はルートの `.prettierrc.json`、対象外は `.prettierignore`（Markdown・
lock ファイル・生成物ほか、理由はそのファイル）。走らせるのはルートで `npm run format:check`
（直すのは `npm run format`。どのファイルを変えても走らせる）。編集時フックが編集したファイルを整形する。
全体を整形したコミットは `.git-blame-ignore-revs` に載せてあり、`git config blame.ignoreRevsFile .git-blame-ignore-revs`
で手元の blame も飛ばせる。

---

## Security Restrictions

NEVER access:

- `.env`（`apps/web/.env` を含む）

---

## Additional Rules

@.claude/docs/workflow.md
@.claude/docs/web-conventions.md
@.claude/docs/testing.md
