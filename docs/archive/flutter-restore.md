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
| ブランチ `archive/flutter` | チェックアウトして触る用。ruleset で削除・force push を禁止 |

両者は同一コミットを指す。ブランチを別に置くのは、タグが GitHub の UI 上で目に入りにくく、
ローカルの `git push --delete` 事故にも弱いため。保護は旧来の branch protection ではなく
ruleset で掛けている——`main` が既に ruleset で守られており、2系統を併存させるとどちらが
効いているのか読めなくなるため。

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

## 3. 凍結先ツリーに入っていないもの

タグが固定するのは**追跡されているファイルだけ**で、以下は含まれない。復元時に別途用意する。

| 要るもの | 置き場所 | 入手元 |
| --- | --- | --- |
| Maps キー（Android） | `secrets.properties` | `secrets.properties.example` を複製して実値を入れる |
| Maps キー（iOS） | `ios/Flutter/Secrets.xcconfig` | `ios/Flutter/Secrets.xcconfig.example` を複製 |
| Maps / Firebase / プロキシ URL（Web） | `dart_defines.json` | `dart_defines.example.json` を複製 |
| Firebase 設定（Android） | `android/app/google-services.json` | **テンプレートが無い。** Firebase Console から取得（§3.1） |

上3つは `.example` が凍結先ツリーに入っているが、**`google-services.json` は雛形すら無い**。
`.gitignore` で除外されているため、クリーンチェックアウトには存在しない。

`ios/Runner/GoogleService-Info.plist` も同じく未追跡だが、**iOS の復元には要らない**（§3.1）。

### 3.1 Firebase 設定ファイル（Android のみ必要）

Firebase プロジェクトは **`aruku-app`**（出所は `lib/firebase_options.dart` の `projectId`。
このファイルは追跡されているので凍結先ツリーから読める）。

**Android は `google-services.json` が無いとビルドが通らない。**
`android/app/build.gradle.kts` が `com.google.gms.google-services` プラグインを適用しており、
**Gradle のビルド時**に設定ファイルを要求する（実行時に渡す `FirebaseOptions` とは無関係）。
Firebase Console → プロジェクト `aruku-app` → プロジェクトの設定 → マイアプリ → Android アプリ
から落として `android/app/` へ置く。

**iOS の `GoogleService-Info.plist` は要らない。** 置いても使われない——
`ios/Runner.xcodeproj/project.pbxproj` にファイル参照も Resources エントリも無く、
アプリバンドルに同梱されない。`lib/main.dart` が
`Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform)` で追跡済みの値を
明示注入しているため、plist を読む経路自体が無い。Firebase Console にアクセスできない人でも
iOS は復元できる。

**Web ビルドにも要らない**（Firebase の値は `lib/firebase_options.dart` から入る）。

**`flutterfire configure` を使ってはいけない。** ネイティブ設定を落とすついでに、
追跡済みの `lib/firebase_options.dart` を生成しなおして上書きする。このファイルは
FlutterFire の素の出力ではなく、API キーを `String.fromEnvironment` に置き換えて
`--dart-define` で注入する形に手を入れてある（同ファイルのコメントと #359 参照）。
上書きすると平文の Firebase キーが追跡ファイルに焼き戻り、凍結したアプリそのものが変わる。

どうしても使う場合は、直後に生成物を戻す:

```bash
git status                                   # 何が書き換わったか確認する
git checkout -- lib/firebase_options.dart    # 追跡ファイルへの上書きを捨てる
```

---

## 4. 復元

```bash
# 1. 取り出す（ブランチとタグはどちらか一方。両方走らせると後の行が前の行を打ち消す）
git fetch origin
git checkout archive/flutter        # 触る／コミットする場合はこちら
#   git checkout flutter-final      # 参照するだけならこちら（detached HEAD になる）

# 2. §3 のファイルを用意する
cp secrets.properties.example secrets.properties
cp ios/Flutter/Secrets.xcconfig.example ios/Flutter/Secrets.xcconfig
cp dart_defines.example.json dart_defines.json
#   Android をビルドするなら google-services.json も Console から落として置く（§3.1）

# 3. 依存を入れる
flutter pub get
```

各ファイルに何を入れるかは README の「Google Maps セットアップ」（キーの発行・配置・
`dart_defines.json` の用意）と「秘匿情報の取り扱い」に書いてある。

---

## 5. 復元できたことの確認

凍結時点（Flutter 3.38.5）で3ターゲットすべて通ることを実測した。同じものが通れば復元成功。

```bash
flutter test
flutter build web --release --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
flutter build apk --release --dart-define-from-file=dart_defines.json
flutter build ios --release --no-codesign --dart-define-from-file=dart_defines.json
```

| | 成功時の出力 | 追加の前提 |
| --- | --- | --- |
| Web | `✓ Built build/web` | 無し |
| Android | `✓ Built build/app/outputs/flutter-apk/app-release.apk` | `google-services.json`（§3.1） |
| iOS | `✓ Built build/ios/iphoneos/Runner.app` | Xcode・CocoaPods（Firebase の設定ファイルは不要。§3.1） |

**Web ビルドだけを判定条件にしない。** Android の Gradle・マニフェスト・プラグイン周りの
壊れ方は Web ビルドを一切通らない——実際、§3.1 の `google-services.json` が凍結先ツリーに
無いという欠陥は、Web ビルドでは永久に検出されない（プラグインが起動しないため）。

**リリース署名は判定条件に要らない。** Android は `android/key.properties` が無ければ
debug 鍵にフォールバックし（`android/app/build.gradle.kts` の `signingConfig` 分岐）、
iOS は `--no-codesign` で署名を飛ばせる。上記は署名鍵を一切置かずに通した。
実機配布まで行う場合の署名手順は README の「リリースビルド（Android 署名）」。

---

## 6. Flutter 版にしか無い機能

React SPA（Web 専用）へ移行すると恒久的に落ちる。復元する動機はたいていここにある。

| 機能 | 実装 | 凍結先での判定箇所 |
| --- | --- | --- |
| 歩数計測 | `pedometer` | `supportsStepCounting`（`lib/core/config/platform_capabilities.dart`） |
| HealthKit 連携（iOS） | `health` | `useHealthKit`（同上） |
| ローカル通知 | `flutter_local_notifications` | `useLocalNotifications`（同上） |

いずれも `!isWeb` で落としているもので、Web 実装が無いのではなく**存在し得ない**
（`pedometer` は Web をプラグイン対象に含めていない）。移行後に必要になったら、
ブラウザ API での代替可否から検討し直すことになる。
