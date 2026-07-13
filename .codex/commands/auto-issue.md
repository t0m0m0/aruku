---
description: GitHub issueを1つ選んで実装→PR作成→reviewerで別コンテキストレビュー→指摘対応まで一気通貫。マージは手動。
argument-hint: "[issue番号（省略時は一覧から選ぶ）]"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(dart:*), Bash(flutter:*), Bash(npm:*), Read, Edit, Write, Grep, Glob, Task
---

# /auto-issue — issue実装からレビュー対応までの半自動フロー

あなたはこのプロジェクトの実装担当です。以下の手順を**順番に**実行してください。
各所に「STOP」がある箇所では**必ずユーザーの承認を待ってから**次に進むこと。

前提ルール（`CLAUDE.md` と `.codex/docs/` が正）:

- 1セッション1機能。TDD。小さな論理単位でコミット。
- `main` へ直コミット禁止 / 失敗テストでコミット禁止 / 無関係ファイルを触らない。
- コミット形式: `feat(#ISSUE): 要約`（tooling系は `chore(#ISSUE):` 等でも可）。
- `dart format .` → `dart analyze` → `flutter test` を**コミット前に必ず**通す。
  `functions/` を変更したら `functions/` で `npm run build` と `npm test` も実行。
- `.env` / `lib/secrets/` / `google-services.json` / `GoogleService-Info.plist` には触れない。
- `pubspec.yaml` は guard 対象。依存追加はユーザー承認必須（Bash経由で適用）。

---

## 0. セッション開始の必須確認

`CLAUDE.md` の「Session Startup」に従い、以下を実行して状態を把握する:

```
pwd
git status --short
git log --oneline -10
```

作業ツリーが汚れている場合はここで**STOP**し、ユーザーに commit / stash を確認する。

## 1. issueの選定

- 引数 `$1` が渡っていれば、その番号のissueを対象にする:
  ```
  gh issue view $1
  ```
- 引数が無ければオープンなissueを一覧提示し、ユーザーに選んでもらう:
  ```
  gh issue list --state open --limit 20
  ```
  → 対象が決まるまで**STOP**（勝手に選ばない）。

issue本文を読み、**受け入れ条件・対象範囲**を自分の言葉で1〜3行に要約する。

## 2. ブランチ作成

issue種別に応じた命名で、`main` から新規ブランチを切る（1 issue 1 branch）:

```
git checkout main && git pull --ff-only
git checkout -b <type>/<issue番号>-<短いslug>
```

`<type>` は `feat` / `fix` / `chore` などissueの性質に合わせる。

## 3. 実装計画の提示（承認ゲート）

- 変更するファイル、追加するテスト、コミットの分割案を**箇条書きで提示**する。
- ここで必ず**STOP**し、ユーザーの承認を得る。承認なしに実装へ進まない。

## 4. TDDで実装

`.codex/agents/worker.md` の流儀に従う:

1. `test/` に失敗するテストを書く
2. `flutter test` で失敗を確認
3. 実装する
4. `flutter test` でパスを確認
5. `dart analyze` でエラーがないことを確認
6. 論理単位ごとにコミット（`feat(#ISSUE): ...`）

`functions/` を変更した場合は、その配下で `npm run build` と `npm test` も通す。

## 5. コミット前の検証（全部通す）

```
dart format .
dart analyze
flutter test
```

いずれか失敗したら**コミットしない**。修正して再実行する。

## 6. PR作成
``
git push -u origin HEAD
gh pr create --fill --base main
```

PR本文には次を明記する（`.codex/docs/workflow.md`）:

- What changed / Why / Test coverageƒ
- `Closes #<issue番号>`

作成された**PR番号を控える**（以降のレビューで使う）。

## 7. 指摘対応

- PRが作成されるとCodexがreviewをしてくれるのでそれを待つƒ
- reviewを確認し、コメントがあれば指摘に対応する。TDDで直し、5章の検証を再度通す。
- `.codex/docs/workflow.md` に従い、**review指摘対応後は確認を取らずに commit & push** する。

```
git commit -m "fix(#ISSUE): レビュー指摘対応 - <要点>"˙ƒ
git push
```

- 対応不要と判断した指摘は、理由を添えてユーザーに報告する（黙って無視しない）。

## 8. 仕上げ（マージは手動）

- 最終状態を要約して報告する:
  - 対象issue / ブランチ / PR URL
  - 追加・変更したテストとその結果
  - reviewer指摘への対応内容
- **マージはしない**。PR URLを提示し、「マージはユーザーが手動で行ってください」と伝えて終了する。
  （自動マージしたくなったら、この章に `gh pr merge <番号> --squash` を追加すればよい。）
