# Flutter 版の復元手順

- **位置づけ:** React SPA へ移行する前の Flutter 版（Web / iOS / Android の3ターゲットが揃った最終状態）を、後から動く形で取り出すための手順書。epic #382 / Phase 0（#383）。
- **凍結先:** タグ `flutter-final` / ブランチ `archive/flutter`
- **関連:** [README.md](../../README.md)（キー・secrets の用意）, [route-optimization.md](../spec/route-optimization.md)（ルート最適化の仕様。移行後も正本）

このファイル中のコードのパス・シンボルは、断りが無い限り**凍結先ツリー上の位置**を指す。
`main` からは Phase 4 で Flutter 資産が消えるため、`main` に同じものがある保証は無い。

---

## 1. 凍結先と使い分け

| | 用途 |
| --- | --- |
| タグ `flutter-final` | 「あの時点」を指す不変の名前。参照・引用はこちら |
| ブランチ `archive/flutter` | チェックアウトして触る用。branch protection で削除不可 |

両者は同一コミットを指す。ブランチを別に置くのは、タグが GitHub の UI 上で目に入りにくく、
ローカルの `git push --delete` 事故にも弱いため。

**別リポジトリには切り出していない。** 誰も `flutter pub get` を回さないリポジトリは依存が
腐り、CI が赤くなっても直す動機が無く、「動く状態で残した」という前提だけが嘘になる。
secrets が2セット・CI が2本・Firebase 設定が2箇所に分岐する保守コストも乗る。
Flutter のバージョンが CI に pin されている（§2）ため、git のタグで条件は足りている。

---

## 2. Flutter のバージョン

**3.38.5（stable）。**

値の出所は `.github/workflows/deploy-web.yml` の `FLUTTER_VERSION` と
`.github/workflows/ci.yml` の `flutter-version`（同じ値が2箇所にある）。この手順書の数字と
食い違ったらワークフロー側が正——凍結時点のワークフローは凍結先ツリーに入っているので、
`git show flutter-final:.github/workflows/deploy-web.yml` で確認できる。

Flutter SDK 自体が git リポジトリなので、切り替えは SDK ディレクトリで:

```bash
git -C <flutter-sdk> checkout 3.38.5
```

---

## 3. 復元

```bash
# 1. 取り出す
git fetch origin
git checkout archive/flutter        # 触る場合
git checkout flutter-final          # 参照だけなら（detached HEAD）

# 2. secrets を用意する（いずれも .gitignore 済み。中身は README を参照）
cp secrets.properties.example secrets.properties               # Android の Maps キー
cp ios/Flutter/Secrets.xcconfig.example ios/Flutter/Secrets.xcconfig  # iOS の Maps キー
cp dart_defines.example.json dart_defines.json                 # Web の Maps キー・Firebase・プロキシ URL

# 3. 依存を入れる
flutter pub get
```

各ファイルに何を入れるかは README の「Google Maps セットアップ」（キーの発行・配置・
`dart_defines.json` の用意）と「秘匿情報の取り扱い」に書いてある。

Firebase の設定ファイル（`android/app/google-services.json` /
`ios/Runner/GoogleService-Info.plist`）は凍結先ツリーに入っている。

---

## 4. 復元できたことの確認

凍結時点で通ることを確認したコマンド:

```bash
flutter test
flutter build web --release --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
```

`✓ Built build/web` が出れば復元成功。iOS / Android は署名が要るため、ビルドの成否を
凍結の判定条件には入れていない（手順は README の「リリースビルド（Android 署名）」）。

---

## 5. Flutter 版にしか無い機能

React SPA（Web 専用）へ移行すると恒久的に落ちる。復元する動機はたいていここにある。

| 機能 | 実装 | 凍結先での判定箇所 |
| --- | --- | --- |
| 歩数計測 | `pedometer` | `supportsStepCounting`（`lib/core/config/platform_capabilities.dart`） |
| HealthKit 連携（iOS） | `health` | `useHealthKit`（同上） |
| ローカル通知 | `flutter_local_notifications` | `useLocalNotifications`（同上） |

いずれも `!isWeb` で落としているもので、Web 実装が無いのではなく**存在し得ない**
（`pedometer` は Web をプラグイン対象に含めていない）。移行後に必要になったら、
ブラウザ API での代替可否から検討し直すことになる。
