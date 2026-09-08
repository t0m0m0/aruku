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

**別リポジトリには切り出していない。** secrets が2セット・CI が2本・Firebase 設定が
2箇所に分岐する保守コストに、復元性の見返りが無いため（#383）。

**ただし「同じリポジトリに置いたから腐らない」ではない。** `archive/flutter` を定期的に
検証する仕組みは無い——`.github/workflows/ci.yml` は `main` への push と pull request で
しか走らず、Phase 4 で Flutter が `main` から消えた後、このブランチをビルドする経路は
どこにも残らない。git が固定できるのは追跡ツリーと、そこに書かれたバージョン指定だけ:

| 固定される | 固定されない |
| --- | --- |
| Flutter 3.38.5（§2 のワークフロー pin） | ホストの Xcode・JDK・macOS |
| pub パッケージ（`pubspec.lock`） | **CocoaPods 実行ファイルそのもの**（下記） |
| Pod の解決結果（`ios/Podfile.lock`） | pub.dev・CocoaPods CDN・Maven の可用性 |
| Gradle wrapper・AGP・Kotlin（`android/settings.gradle.kts` ほか） | 各レジストリからのパッケージ取り下げ |

`ios/Podfile.lock` が固定するのは**解決された Pod のバージョンだけ**。末尾の
`COCOAPODS: 1.16.2` は解決に使われたバージョンの記録であって、その版を選びも入れもしない。
`Gemfile` / `Gemfile.lock` は凍結先ツリーに無いので、`flutter build ios` はホストに入っている
CocoaPods をそのまま使う。版が違えば導入時の挙動や生成される Pods プロジェクトが変わり得る。

右側が動いた場合、**赤くなる場所が無いまま**復元できなくなる。復元性は凍結時点での
best-effort であり、いま生きているかは §5 を走らせて初めて分かる。

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

## 3. 凍結が固定しないもの

タグが固定するのは**追跡されているファイルだけ**。以下のファイルは含まれないので復元時に
別途用意する（外部サービスについては §3.2）。

| 要るもの | 置き場所 | 入手元 |
| --- | --- | --- |
| Maps キー（Android） | `secrets.properties` | `secrets.properties.example` を複製して実値を入れる |
| Maps キー（iOS） | `ios/Flutter/Secrets.xcconfig` | `ios/Flutter/Secrets.xcconfig.example` を複製 |
| Firebase の API キー（**3ターゲットぶん**）・Maps キー（Web）・プロキシ URL | `dart_defines.json` | `dart_defines.example.json` を複製し、実値を Firebase / Google Cloud Console から入れる |
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
明示注入しているため、plist を読む経路自体が無い。**Web ビルドにも要らない**（同じ理由）。

**ただし「plist が要らない」は「Firebase Console が要らない」ではない。** iOS も
`lib/firebase_options.dart` が `apiKey` を `String.fromEnvironment('FIREBASE_IOS_API_KEY')`
で受けており、実値は Console から取って `dart_defines.json` に入れる（`.example` は
プレースホルダのみ）。空のままだとビルドは通るが、`lib/main.dart` の
`_assertFirebaseOptionsComplete` が `Firebase.initializeApp` の前で `StateError` を投げる
（release ビルドでは assert が外れるので、代わりに Firebase 側が実行時に失敗する）。
Console アクセスはどのターゲットでも要る。iOS で不要なのは plist という**ファイル**だけ。

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

### 3.2 凍結が届かない外部依存

タグが固定できるのはこのリポジトリのファイルだけで、**アプリが動くために要る外部の状態は
入らない**。この手順書は以下が生きている前提で書いている。

| 外部依存 | 欠けるとどうなる | 復旧の手掛かり |
| --- | --- | --- |
| Firebase プロジェクト `aruku-app`（App Check 登録・Firestore） | 検索が 401 になる | README「レートリミッタ（Firestore）」 |
| デプロイ済みの `placesProxy` / `googleWalkProxy` / `googleWalkMatrixProxy` | 地点検索と徒歩実測が失敗 | `functions/` を再デプロイ |
| Secret Manager の `GOOGLE_MAPS_API_KEY`（`functions/src/index.ts`） | プロキシが上流を叩けない | README・[security_hardening.md](../security_hardening.md) |
| Secret Manager の `RATE_LIMIT_HMAC_KEY`（`functions/src/rate-limiter.ts`） | レート制限が**黙ってフェイルオープン**する（保護が無効のまま気付けない） | 同上 |
| **Transit API（`https://api.transit.ls8h.com`）** | **ルートが一切出ない** | 代替なし（下記） |

**Transit API は凍結の対象外であり、復元性の上限を決めている。** 公共交通のプロキシは
このリポジトリに無く、クライアントが第三者サービスを直接叩く（`lib/core/config/app_config.dart`
の `TRANSIT_API_BASE_URL`、既定値がこのホスト。[route-optimization.md](../spec/route-optimization.md)）。
サービスが消えるか契約が変われば、**ビルドも起動も地図も地点検索も通ったまま、ルートだけが
出なくなる**。git のタグでは防げない種類の劣化で、§1 の「固定されない」側の最上位に来る。

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

**復元成功の条件は2段ある。** ビルドが通ること（§5.1）と、設定値が生きていること（§5.2）。
§5.1 だけでは、起動しないアプリを「復元成功」と判定できてしまう。

### 5.1 ビルド（凍結時点で実測済み）

Flutter 3.38.5 で3ターゲットとも通ることを確認した。

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

### 5.2 起動確認（設定値の検証）

§5.1 は **`dart_defines.json` の中身を一切見ない。** `flutter test` は `lib/main.dart` を
通らず（`test/widget_test.dart` は `ArukuApp` を直接 pump する）、release ビルドは
コンパイルするだけで Firebase にも Maps にもプロキシにも接続しない。§3.1 のとおり
release では `_assertFirebaseOptionsComplete` の assert も外れる。値がプレースホルダの
ままでも §5.1 は全部通る。

**3ターゲットそれぞれで debug 起動する。1つでは足りない。**
`DefaultFirebaseOptions.currentPlatform` は `kIsWeb` を最初に見るため、Chrome だけで
確認しても `FIREBASE_ANDROID_API_KEY` と `FIREBASE_IOS_API_KEY` は一度も読まれない。
Maps キーも Web は `MAPS_WEB_API_KEY`（dart-define）、ネイティブは `secrets.properties` /
`ios/Flutter/Secrets.xcconfig`（ビルド時にマニフェスト・Info.plist へ注入）と経路が別。
Web が正常でもネイティブが使えない状態が成立する。

```bash
flutter run -d chrome --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
flutter run -d <Android エミュレータ／実機> --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
flutter run -d <iOS シミュレータ／実機> --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
```

各ターゲットで見るところ:

| 見るところ | 通れば分かること |
| --- | --- |
| 起動時に `Firebase の … が空です`（`StateError`）が出ない | そのターゲットの Firebase キーが入っている（`lib/main.dart` の `_assertFirebaseOptionsComplete`） |
| 実地図が描画される | Maps キー（Web: `MAPS_WEB_API_KEY` / Android: `secrets.properties` / iOS: `ios/Flutter/Secrets.xcconfig`） |
| 地点検索が候補を返す（**デプロイ済みプロキシ相手**） | `PROXY_BASE_URL`・App Check の資格情報 |
| **ルート検索が結果を返す** | Transit API（§3.2）まで含めたコア機能全体。ここまで通して初めて「使える」 |

**エミュレータ相手の検索は App Check を検証しない。** `dart_defines.example.json` の
`PROXY_BASE_URL` はローカルの Functions エミュレータを指しており、`functions/src/index.ts` の
`verifyAppCheck` は `FUNCTIONS_EMULATOR` が true なら無条件に通す。さらに
`lib/core/services/app_check_http_client.dart` の `_tokenFrom` はトークン取得の失敗を
握り潰してヘッダ無しのまま送る。この2つが重なるため、資格情報がプレースホルダ・無効・
未登録のいずれでも検索は成功し、デプロイ済みプロキシでは 401 になる。**デプロイ済みの
プロキシに向けて1回検索するまで、App Check の資格情報は未検証のまま。**

**debug 起動では release の App Check 資格情報は検証されない。** `lib/main.dart` は
`useDebugAppCheckProvider` が真なら `WebDebugProvider` / `AndroidDebugProvider` /
`AppleDebugProvider` を選ぶ。通るのは登録済みのデバッグトークンだけで、release Web が使う
`ReCaptchaV3Provider`（`RECAPTCHA_SITE_KEY`）とネイティブの実機アテステーションは一度も
走らない。`RECAPTCHA_SITE_KEY` が `.example` のプレースホルダのままでも上の確認は全部通り、
release ビルドだけが 401 になる。そこまで確かめるなら release ビルドで同じ確認をする。

**この起動確認は凍結時点では実測していない**——復元する人が用意した値に依存するため。
ネイティブ2つを省く場合は、**ネイティブの実行時設定は未検証のまま**であることを
承知の上で行う。

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
