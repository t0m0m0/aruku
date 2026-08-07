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

- `lib/core/` — config, constants, models, services, state (Riverpod), navigation, theme
- `lib/features/` — feature-first UI (onboarding, home, search, picker, loading, result, settings, error)
- `lib/shared/` — reusable widgets, extensions, icons
- `functions/` — Cloud Functions **TypeScript** backend. Google Places / Routes proxies (`placesProxy`, `googleWalkProxy`, `googleWalkMatrixProxy`) + Firestore rate limiter. **公共交通のプロキシは無い** — Transit API はクライアント直叩き（`docs/spec/route-optimization.md` §2.1）
- Run the app: `flutter run` (add `--dart-define=USE_REAL_MAP=true` for the real map). Setup: see README.

### Navigation

- go_router が画面遷移の権威（`lib/core/navigation/app_router.dart` の `goRouterProvider`）。ルートツリー・戻る挙動・遷移アニメはここに集約。
- アプリ内遷移は今まで通り `ref.read(appStateProvider.notifier).go(Screen.x)`。`AppState.screen` は router のミラーで、pop / deep link は自動で書き戻される。
- 画面と表示前提データ（loading↔routePhase、result/nav↔route、error↔routeErrorKind）は**必ず同一 `copyWith` で**更新する（redirect ガードの前提）。

---

## Core Workflow

IMPORTANT:

- Implement only ONE feature per session
- Follow TDD
- Commit in small logical units
- When writing version tags for external tools (GitHub Actions, Flutter, packages, etc.), **always fetch the latest version via WebSearch before writing**. Never rely on training-data knowledge for version numbers.

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

```dart
// 素直には depTime でソートしたいが、untimed 便は depTime が null で
// 末尾に沈むため arrTime を採用している。#121 参照。
candidates.sort((a, b) => a.arrTime.compareTo(b.arrTime));
```

---

## Validation Commands

Before every commit, run:

- `dart format .`
- `dart analyze`
- `flutter test`

When `functions/` changes, also run in `functions/`:

- `npm run build`  (tsc)
- `npm test`       (vitest)

---

## Security Restrictions

NEVER access:

- `.env`
- `lib/secrets/`

NEVER modify:

- `android/app/google-services.json`
- `ios/Runner/GoogleService-Info.plist`

---

## Additional Rules

@.claude/docs/workflow.md
@.claude/docs/flutter-conventions.md
@.claude/docs/testing.md
