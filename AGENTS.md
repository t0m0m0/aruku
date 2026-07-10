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

- `lib/core/` — config, models, services, state (Riverpod), geo, navigation
- `lib/features/` — feature-first UI (auth, home, search, picker, result, navigation, settings, onboarding, …)
- `lib/shared/` — reusable widgets, extensions, icons
- `functions/` — Cloud Functions **TypeScript** backend (Maps/transit proxy + Firestore rate limiter)
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

@.Codex/docs/workflow.md
@.Codex/docs/flutter-conventions.md
@.Codex/docs/testing.md
