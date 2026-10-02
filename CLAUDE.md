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
  - `src/features/` — 画面（home, search, picker, loading, result, error）
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

## Where to Write What

情報は「どこに書けば寿命が合うか」で置き場所を決める。

| 場所 | 書くこと | 具体例 |
| --- | --- | --- |
| コード | **How** — どう実現しているか | 命名・構造・型でHowを語る。コメントで説明しない |
| テストコード | **What** — 何を満たすべきか | テスト名が仕様書になるように書く |
| コミットログ | **Why** — なぜこの変更が必要か | 背景・課題・意思決定。issue番号と紐づける |
| コードコメント | **Why not** — なぜ他の方法を採らなかったか | 制約・罠・見送った代替案 |

IMPORTANT:

- コメントに How を書かない（コードの重複であり、腐る）
- コメントに Why を書かない（コミットログの仕事）
- 「なぜこう書いていないのか」がコードから復元できないときだけコメントを足す

例:

```ts
// 素直には depTime でソートしたいが、untimed 便は depTime が null で
// 末尾に沈むため arrTime を採用している。#121 参照。
candidates.sort((a, b) => a.arrTime.getTime() - b.arrTime.getTime());
```

---

## Keeping Docs in Sync

IMPORTANT: **コードを変えたら、その挙動を説明しているコメント・ドキュメントを同じコミットで直す。**
別コミットにしない——分けた時点で「後で」になり、実際には直らない（#357 で3件が腐っていた）。

同じコミットで見直す対象:

| 変えたもの | 見直す先 |
| --- | --- |
| 関数・クラス・定数の挙動 | その doc comment と、直上の行コメント |
| シンボルの撤去・改名 | 他ファイルのコメント・`docs/`・`README.md` に残る言及 |
| ファイルの削除・移動 | コメント／ドキュメントに書かれたパス |
| 仕様に書かれた挙動 | `docs/spec/route-optimization.md`（`§N` 参照も含む） |
| セキュリティ・運用手順 | `docs/security_hardening.md`・`docs/ops/` |

腐りやすいのは**断定**（「常に null」「表示ごと廃止」「〜しない」）。前提が戻ると丸ごと嘘になる。

**意図的に残す場合は、なぜ残すのかをコメントに書く。** 到達しないコード・使われないフィールドを
残す判断自体は正当（例: `RouteSegment.fare`）。書いていないと次に読む人が腐りと区別できない。

この規約は `.claude/doc_consistency.py` が commit 前に機械的に検査し（消えたシンボルへの参照・
存在しないパス・存在しない `§N`）、CI でも同じ検査が走る。機械で判定できない意味的な食い違いは
commit 前のエージェントフックが見る。**検査に引っかかったら、既定は記述を直すこと。**

例外は「撤去の経緯そのものを書いている記述」だけ——`` `navitimeProxy` は #330 で撤去した ``の
ような行は、消えたシンボル名が出てくるのが正しい。その行に `doc-consistency:keep` を書くと
検査から外れる。**腐りを黙らせるために使わない。** 消えた名前が説明の主題ではなく、まだ在るかの
ように書かれているなら、それは直す対象。

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

@.claude/docs/workflow.md
@.claude/docs/web-conventions.md
@.claude/docs/testing.md
