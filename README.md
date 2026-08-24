# aruku（あるく）

「電車に乗らず、時間内で最大限歩く」ルート案内アプリ（Flutter）。

## Google Maps セットアップ

地図・ルート・検索機能は Google Maps Platform の API キーを必要とします。
**平文キーは絶対にコミットしないでください**（`secrets.properties` /
`ios/Flutter/Secrets.xcconfig` は `.gitignore` 済み）。

**この節（1〜5）で動くのは地図表示までです。** 地点検索と徒歩実測は Cloud Functions プロキシ
経由のため、別途「[プロキシを動かす](#プロキシを動かす地点検索徒歩実測)」の設定が要ります。

### 1. API キーの発行

[Google Cloud Console](https://console.cloud.google.com/) で必要な API を有効化し、
キーを発行します。

| 用途 | API | 呼び出し元 | キーの置き場所 |
|---|---|---|---|
| 地図表示（Android） | Maps SDK for Android | アプリ（ネイティブ SDK） | `secrets.properties` |
| 地図表示（iOS） | Maps SDK for iOS | アプリ（ネイティブ SDK） | `ios/Flutter/Secrets.xcconfig` |
| 地図表示（Web） | Maps JavaScript API | ブラウザ（実行時に script を注入） | `dart_defines.json` `MAPS_WEB_API_KEY` |
| 徒歩の所要・距離・街路ジオメトリ | Routes API | `googleWalkProxy` / `googleWalkMatrixProxy` | Secret Manager `GOOGLE_MAPS_API_KEY` |
| 地点検索 | Places API (New) | `placesProxy` | Secret Manager `GOOGLE_MAPS_API_KEY` |
| 公共交通の経路 | — （Transit API・認証不要） | アプリから直接 | 不要 |

**本番では地図表示用キーを Android 用・iOS 用・Web 用に分け、プロキシ用と合わせて 4 本にします。**
Google の API キーは**アプリケーション制限を 1 種類しか持てない**ため、1 本のキーに
Android パッケージ名と iOS Bundle ID の両方を掛けることはできません（[Google の
セキュリティ ガイダンス](https://developers.google.com/maps/api-security-best-practices)）。
`secrets.properties` と `Secrets.xcconfig` は別ファイルなので、値を分けるだけで対応できます。
制限の掛け方は [docs/security_hardening.md](docs/security_hardening.md) ① が正本です。

> 開発中は制限なしのキー 1 本を両プラットフォームで使い回しても動きます。分離が要るのは
> アプリケーション制限を掛ける本番前です。

公共交通だけは Google ではなく Transit API（`https://api.transit.ls8h.com`）をクライアントから
直接呼ぶため、キーも API 有効化も要りません（[ルート最適化 仕様](docs/spec/route-optimization.md) §2）。

### 2. キーファイルの配置

テンプレートをコピーして実キーを設定します。

```sh
cp secrets.properties.example secrets.properties
cp ios/Flutter/Secrets.xcconfig.example ios/Flutter/Secrets.xcconfig
```

両ファイルの `MAPS_API_KEY` にキーを設定します。開発中は同じキーで構いません。
本番では §1 のとおり Android 用・iOS 用に別のキーを入れます。

- `secrets.properties` … Android（Gradle がビルド時に AndroidManifest へ注入）
- `ios/Flutter/Secrets.xcconfig` … iOS（xcconfig → Info.plist `GMSApiKey` 経由で読込）

> **CI など、テンプレートをコピーしない環境での代替手段（プラットフォーム差に注意）:**
>
> - **Android**: 環境変数 `MAPS_API_KEY` をそのまま利用できます。`secrets.properties`
>   が無い場合、Gradle が `System.getenv("MAPS_API_KEY")` を読み込みます。
> - **iOS**: xcconfig はシェル環境変数を直接読み込めません。また
>   `AppDelegate` のランタイム環境変数フォールバックは `--dart-define` では
>   設定されません（`--dart-define` は Dart コンパイル定数で `ProcessInfo`
>   には届きません）。CI では **ビルド前に環境変数から `Secrets.xcconfig` を
>   生成** してください:
>
>   ```sh
>   echo "MAPS_API_KEY = $MAPS_API_KEY" > ios/Flutter/Secrets.xcconfig
>   ```

### 3. dart-define ファイルの用意（**起動に必須**）

アプリは Firebase を初期化するため、`FIREBASE_ANDROID_API_KEY` / `FIREBASE_IOS_API_KEY` を
dart-define で受け取ります。**未設定だと debug ビルドは起動時に `StateError` で落ちます**
（`lib/main.dart` の `_assertFirebaseOptionsComplete`）。地図表示だけを試す場合でも必要です。

```sh
cp dart_defines.example.json dart_defines.json
#   FIREBASE_ANDROID_API_KEY / FIREBASE_IOS_API_KEY に実キーを設定
#   （Firebase Console → プロジェクトの設定 → マイアプリ）
```

Web で動かす場合は `FIREBASE_WEB_API_KEY` と `FIREBASE_WEB_APP_ID` も設定します。
Web の `appId` は android / ios と違いコードに焼いていないため、
**Firebase Console で Web アプリを登録してから値を取得**してください
（`lib/firebase_options.dart` の `web`）。両方とも同じ検査に掛かるので、
片方でも空なら debug ビルドは起動時に落ちます。

Web で実地図を出す場合は `MAPS_WEB_API_KEY`（Maps JavaScript API キー）も設定します。
未設定なら実地図の読み込みを見送り、スタイライズド地図のままになります（起動は落ちません）。

**ここに入れるのは開発用キーです。** 開発用は許可リストに `localhost` を含めるため、
キーを知っている者なら誰でも使えます（`localhost` は誰のマシンにもあり所有を証明しない）。
公開ビルドには配信ドメインだけを許可した別のキーを渡してください。分け方は
[docs/security_hardening.md](docs/security_hardening.md) ①④ が正本です。

`dart_defines.json` は gitignore 済みです。**コミットしないでください。**

### 4. ビルド・実行

```sh
flutter pub get
flutter run --dart-define-from-file=dart_defines.json
```

VS Code の `.vscode/launch.json` は同ファイルを自動で読むため、F5 実行ならオプションは不要です。

Maps のキーが未設定でもアプリは起動し、地図はスタイライズド・プレースホルダで描画されます。

### 5. 実地図（GoogleMap）の表示

キー設定後、`USE_REAL_MAP` フラグを付けると実地図が表示されます。

```sh
flutter run --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
```

（既定では実地図を有効化しません。地図 UI の本格統合・テーマ適用は別 ISSUE で対応します）

**Web ではフラグに加えて `MAPS_WEB_API_KEY` が要ります。** `google_maps_flutter_web` は
`window.google.maps` が在る前提で動くため、キーから組んだ script タグを実行時に注入し、
読み込みが済むまで `supportsRealMap` が実地図を塞ぎます（`lib/core/services/maps_js_loader.dart`）。
どちらかが欠ければスタイライズド地図のままです。

script タグを `web/index.html` へ直書きしないのは、このリポジトリが public で、
追跡ファイルにキーを置くと履歴に恒久的に残るためです。**ただしこれは秘匿ではありません。**
dart-define はコンパイル時定数として `main.dart.js` に焼き込まれ、ブラウザから読めます。
実運用の防御はリファラー制限と GCP のクォータ上限で、**そのリファラー制限が効くのは
`localhost` を含めない本番用キーだけ**です。

開発中は次のように起動します（ポートは許可リストに登録した値に固定する）。

```sh
flutter run -d chrome --web-port=5555 \
  --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
```

現時点で Web の地図には既知の見た目の差があります（#359 Phase 2b）:

- 出発地・目的地のピンが色分けされず既定の赤になる。`BitmapDescriptor.defaultMarkerWithHue`
  に Web 実装が無く、例外にならないまま既定アイコンへ落ちるため
- ローディング画面の淡く沈めた背景地図が、フル彩度で描画される。`Opacity` と
  `ColorFiltered` はプラットフォームビューへ適用されないため

## プロキシを動かす（地点検索・徒歩実測）

**地点検索と徒歩実測は上記のキー設定だけでは動きません。** どちらも Cloud Functions
プロキシ経由で、アプリはプロキシの URL を `PROXY_BASE_URL`（dart-define）から読みます。
未設定のとき `GooglePlacesService` は**例外ではなく空リストを返す**ため、
「検索しても候補が0件」という**エラーに見えない形**で失敗します（`lib/core/services/places_service.dart`）。

必要なものは3つ。

| # | 設定 | 置き場所 |
|---|---|---|
| 1 | `PROXY_BASE_URL` | `dart_defines.json`（セットアップ 3 で作成済み） |
| 2 | サーバー側の Google キー `GOOGLE_MAPS_API_KEY`（Routes API + Places API (New) を有効化） | エミュレータは環境変数 / 本番は Secret Manager |
| 3 | App Check デバッグトークン | `dart_defines.json` ＋ Firebase Console への登録 |

**① `PROXY_BASE_URL` を決める。** 値は**アプリを動かす場所から見たホストのアドレス**で、
実行先ごとに違います（macOS は `lib/firebase_options.dart` が `UnsupportedError` を
投げるため動きません）。

**ローカルの Functions エミュレータを叩けるのは iOS シミュレータ・Android・Web です。**
塞がっているのは iOS 実機だけで、その場合はデプロイ済みプロキシを使います。

| アプリの実行先 | ローカルの Functions エミュレータを叩く | デプロイ済みプロキシを叩く |
|---|---|---|
| iOS シミュレータ | `http://127.0.0.1:5001/{projectId}/asia-northeast1` | ✅ |
| iOS 実機 | **不可** — iOS 14+ のローカルネットワークプライバシー。LAN 上の IP へ繋ぐには `Info.plist` に `NSLocalNetworkUsageDescription` が要るが、開発専用の用途で全ユーザーに権限要求を出したくないため入れていない | ✅ |
| Android エミュレータ | `http://10.0.2.2:5001/{projectId}/asia-northeast1`（`10.0.2.2` はエミュレータから見たホストの別名） | ✅ |
| Android 実機 | `adb reverse tcp:5001 tcp:5001` してから `http://127.0.0.1:5001/{projectId}/asia-northeast1` | ✅ |
| Web | `http://127.0.0.1:5001/{projectId}/asia-northeast1` | ✅ ただし **App Check の設定が前提**（下記） |

デプロイ済みプロキシの URL は実行先を問わず
`https://asia-northeast1-{projectId}.cloudfunctions.net` です。

**Web からデプロイ済みプロキシを叩くには App Check の設定が要ります。**
`RECAPTCHA_SITE_KEY`（reCAPTCHA v3 サイトキー）を dart-define で渡すと
`ReCaptchaV3Provider` で有効化します。

`WebDebugProvider` を使う条件はビルド種別で違います（`useDebugAppCheckProvider`）。

| ビルド | `WEB_APP_CHECK_DEBUG_TOKEN` | 挙動 |
|---|---|---|
| debug | 不要 | 常に `WebDebugProvider`。未指定なら Firebase JS SDK がトークンを自動生成してコンソールへ出力する |
| profile | **必須** | トークンを渡したときだけ `WebDebugProvider`。渡さないとサイトキーが無い限り `activate` を呼ばない |
| release | 効果なし | `RECAPTCHA_SITE_KEY` のみ |

profile でトークンを要求するのは、提出物にバイパス経路を混入させないための境界です
（`lib/core/config/app_check_provider.dart` 参照）。

サイトキーもデバッグプロバイダも無い場合は `activate` を呼びません
（`canActivateWebAppCheck`）。`providerWeb` を渡さない `activate` は同期的に
throw してアプリが起動しなくなるためで、この場合プロキシは 401 を返します。

準備するもの:

1. reCAPTCHA 管理コンソールで **reCAPTCHA v3** のサイトを登録し、配信ドメイン
   （ローカル開発なら `localhost`）を追加する。**サイトキーとシークレットキーの
   2つが発行される**
2. Firebase Console → **Security → App Check → Apps** タブでこの Web アプリに
   reCAPTCHA v3 プロバイダを登録する。ここに入れるのは**シークレットキー**
3. `dart_defines.json` の `RECAPTCHA_SITE_KEY` に**サイトキー**（公開鍵）を書く

**2 と 3 で入れる鍵は別物です。** Firebase 側はトークン検証にシークレットを使い、
アプリ側は `ReCaptchaV3Provider` にサイトキーを渡します。取り違えると検証が通りません。

> debug ビルドで `WebDebugProvider` を使う場合、トークンを渡さなければ Firebase JS
> SDK が自動生成してブラウザのコンソールへ出力します。その値を Firebase Console →
> Security → App Check → Apps タブ → 対象アプリの ⋮ → **デバッグトークンを管理**
> に登録してください。登録すればデプロイ済みのバックエンドでも通ります。
> **デバッグトークンはコミットしないこと。**

**ローカルのエミュレータなら Web でも動きます。** `functions/src/index.ts` の
`verifyAppCheck` は `FUNCTIONS_EMULATOR` が立っているとき検証ごとスキップし、
プロキシは `Access-Control-Allow-Origin: *` とプリフライトに対応済みです。
つまり Web のローカル開発は Phase 1 を待たずに完結します。ページを `http` で配信して
いれば `http://127.0.0.1:5001` への呼び出しも混在コンテンツになりません。

手順は下の **② Functions エミュレータを起動する**（`npm run build` が必須。
ビルドしないと読み込む関数が無い状態で起動します）と同じです。そのうえで
`dart_defines.json` の `PROXY_BASE_URL` を
`http://127.0.0.1:5001/{projectId}/asia-northeast1` にして起動します。

```sh
flutter run -d chrome --dart-define-from-file=dart_defines.json
```

これで地点検索・徒歩実測・経路検索まで通ります（新宿駅→東京駅で実証済み。
`placesProxy` / `googleWalkProxy` / `googleWalkMatrixProxy` がすべて 200 を返す）。

> **Web の現在地取得はブラウザの許可が要ります。** `http://localhost` は secure context
> なので geolocation API 自体は使えますが、許可を拒否すると `LocationDenied` になり
> 「位置情報なし」と表示されます（アプリ側の失敗ではありません）。一度拒否すると
> プロンプトは再表示されないため、サイト設定から許可し直してください。

> iOS の URL は `localhost` ではなく **IP リテラル（`127.0.0.1`）で書く**こと。ATS は IP アドレスへの
> 接続には適用されない（iOS 10 以降は常に許可）が、`localhost` や `*.local` は**ホスト名なので ATS の
> 対象**になり、`NSAllowsLocalNetworking` を足さないと平文が弾かれる。本プロジェクトは
> `Info.plist` に ATS 例外を持たない（デプロイ target は iOS 15.0）。

> Android は `targetSdk` が 36 で、`AndroidManifest.xml` に `usesCleartextTraffic` も
> `networkSecurityConfig` もありません。それでも**平文 HTTP は通ります**。Android 9+ の平文禁止は
> `NetworkSecurityPolicy` を**参照するライブラリ**（OkHttp・`HttpURLConnection`・Cronet・WebView）
> にしか効かないためです。本アプリの通信は `package:http` → `dart:io` の `HttpClient` で、
> Dart VM が生ソケット上に持つ独自スタックなのでこのポリシーを通りません。
> **マニフェストに平文許可を足す必要はなく、足しても挙動は変わりません**（#349 で実測確認）。

**② Functions エミュレータを起動する。** `package.json` の `main` は `lib/index.js`
（tsc の出力・gitignore 済み）なので、**ビルドしないとエミュレータは読み込む関数が無い状態で起動します**。

```sh
# 別ターミナルで実行し、起動したままにする
cd functions
npm install
npm run build
GOOGLE_MAPS_API_KEY='ここにサーバー側キー' npx -y firebase-tools@latest emulators:start --only functions
```

> `firebase` CLI をグローバルに入れている場合は、`npm run build` と起動をまとめた
> `GOOGLE_MAPS_API_KEY='ここにサーバー側キー' npm run serve` で代用できます（`firebase-tools` は
> devDependency に含めていないため、未インストールなら上記の `npx` 版を使ってください）。
> macOS で Keychain にキーを登録済みなら `npm run dev` がキーの取り出しまで行います。

**③ アプリを起動する。** リポジトリのルートで実行します（上のブロックで `cd functions`
しているので、同じターミナルを使うなら先に `cd ..` してください）。

```sh
flutter run --dart-define-from-file=dart_defines.json --dart-define=USE_REAL_MAP=true
```

- エミュレータ実行時は App Check 検証とレート制限の Firestore 依存が外れるため、
  Firestore エミュレータは不要です（レート制限はインメモリ実装へフォールバック）。
- 実機のデバッグビルドから**デプロイ済み**プロキシを叩く場合は App Check が必須です。
  `dart_defines.json` のデバッグトークンと同じ値を Firebase Console → App Check → デバッグトークン
  に登録してください。未登録だと 401 になります。

## リリースビルド（Android 署名）

リリースビルドは本番署名鍵で署名します。`android/key.properties` を配置すると
Gradle がその keystore で `release` を署名し、未配置の開発環境では debug 鍵に
フォールバックして `flutter run --release` を壊しません。

```sh
# 1. keystore を生成（一度だけ。安全な場所に保管しコミットしない）
keytool -genkey -v -keystore ~/aruku-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias aruku

# 2. テンプレートをコピーして実値を設定
cp android/key.properties.example android/key.properties
#   storeFile / storePassword / keyAlias / keyPassword を編集

# 3. 署名済みリリースをビルド
flutter build appbundle --release
```

`android/key.properties` と keystore（`*.jks` / `*.keystore`）は gitignore 済みです。
**絶対にコミットしないでください。**

## Web 公開（Cloudflare Pages）

`main` への push で `.github/workflows/deploy-web.yml` が `flutter build web` の成果物を
Cloudflare Pages へ配信します。静的配信先に Cloudflare を選んだのは、Flutter の web 出力が
初回ロードで数 MB になり、転送量に上限のある無料枠（Firebase Hosting Spark は 10GB/月）だと
先に頭を打つためです。Vercel Hobby は帯域では足りますが ToS が非商用限定で、収益化
（#238〜#240）と両立しません。

**配信の費用はこの構成では実質かかりません。** 課金が発生し得るのは Google Maps Platform
（SKU ごとの月間無料枠を超えた分）と Cloud Functions（Blaze）で、いずれも配信先の選択とは
無関係です。

### 1. Pages プロジェクトの作成

ワークフローはプロジェクトが既にある前提で `pages deploy` します。一度だけ作成します。

```sh
npx --yes wrangler@latest pages project create aruku --production-branch=main
```

名前を変える場合は `deploy-web.yml` の `PAGES_PROJECT` も合わせてください。

### 2. GitHub 側の設定

| 種別 | 名前 | 内容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 権限「Cloudflare Pages: 編集」のみを持つ API トークン |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボード右側のアカウント ID |
| Secret | `FIREBASE_WEB_API_KEY` / `FIREBASE_WEB_APP_ID` | Firebase Console → プロジェクトの設定 → マイアプリ（Web）|
| Secret | `RECAPTCHA_SITE_KEY` | Web の App Check（reCAPTCHA v3）サイトキー。未設定だとプロキシが 401 |
| Secret | `MAPS_WEB_API_KEY` | **本番用**の Maps JavaScript API キー（開発用と使い回さない）|
| Variable | `PROXY_BASE_URL` | `https://asia-northeast1-{projectId}.cloudfunctions.net` |

`PROXY_BASE_URL` だけ Variable なのは公開 URL で秘匿する対象ではないためです。いずれも
未設定のままだと空文字がバンドルに焼かれて実行時に壊れるため、ワークフロー冒頭で
存在検査をして落とします。

`environment: production` を使うので、Environment に required reviewers を設定していれば
配信前に承認を挟めます（`deploy-functions.yml` と同じ環境）。

### 3. 公開ドメインの登録

配信ドメインが決まったら次の2か所に登録します。どちらが漏れても、その機能だけが
本番で静かに落ちます（地図が出ない／プロキシが 401）。

- **Maps JavaScript API キーのリファラー制限** — `aruku.pages.dev/*`（独自ドメインなら
  そちら）。**`*.pages.dev` を入れてはいけません。** 他人の Pages プロジェクトを含む
  ワイルドカードになり、リファラー制限が実質無効になります。詳細は
  [docs/security_hardening.md](docs/security_hardening.md) ①。
- **reCAPTCHA v3 サイトキーの許可ドメイン** — reCAPTCHA 管理コンソール（サイトキーを
  Firebase Console → App Check で登録したもの）。登録外のドメインではトークンが
  発行されず、プロキシが 401 を返します。

Firebase Authentication は使っていない（`firebase_auth` に依存していない）ため、
「承認済みドメイン」の設定は不要です。

同じ理由で、このワークフローは PR ごとのプレビュー配信を作りません。プレビューは
デプロイのたびにサブドメインが変わり、リファラー制限で追随できないためです。

### 4. 注意

`--dart-define` で渡した値はコンパイル時定数として `main.dart.js` に焼き込まれ、
ブラウザから読めます。GitHub Secret にするのは履歴に残さず差し替えを効かせるためで、
**公開後の露出は防げません。** 予算アラートと1日あたりのクォータ上限を併せて掛けてください。

## 秘匿情報の取り扱い

| ファイル | 追跡 | 内容 |
|---|---|---|
| `secrets.properties.example` / `ios/Flutter/Secrets.xcconfig.example` | あり | テンプレート（プレースホルダのみ）|
| `secrets.properties` / `ios/Flutter/Secrets.xcconfig` | なし（gitignore）| 実キー。コミット禁止 |
| `android/key.properties.example` | あり | テンプレート（プレースホルダのみ）|
| `android/key.properties` / `*.jks` / `*.keystore` | なし（gitignore）| 署名鍵。コミット禁止 |

公開前のセキュリティ対策（API キー制限・App Check enforcement・署名/証明書ピンニング検討）は
[docs/security_hardening.md](docs/security_hardening.md) を参照（Issue #75）。

## レートリミッタ（Firestore）

Cloud Functions のプロキシは IP 単位のレート制限（標準 30 req/min、徒歩ルートは 90 req/min）を
Firestore で管理します。インスタンスローカルな Map では複数インスタンスへスケールした際に上限が
事実上緩くなるため、`rateLimits` コレクションのドキュメントをトランザクションで更新し、インスタンス
横断で一貫した上限を強制します（Issue #76）。エミュレータ実行時はインメモリ実装にフォールバックし、
Firestore エミュレータは不要です。

ドキュメント ID には生 IP を保存せず、`HMAC-SHA256(鍵, IP)` の 16 進ダイジェストを使います。
鍵は Secret `RATE_LIMIT_HMAC_KEY` と UTC 日付から導出され日次でローテーションするため、鍵を持たない
（＝ Firestore ダンプだけを入手した）攻撃者は生 IP を復元できず、日を跨いだ IP 相関もできません
（Issue #263）。ただし base secret 自体が漏洩した場合は日付が公開情報のため全日分を逆引きできるので、
鍵漏洩時は `RATE_LIMIT_HMAC_KEY` を再発行（ローテーション）してください。本番相当で鍵が未設定または
32 文字未満のときは、逆引き可能なドキュメントを書かずフェイルオープン（通過）し `console.error` に記録します。

本番で機能させるには Firestore データベースのプロビジョニングが一度だけ必要です。

```bash
# 1. Firestore データベースを作成（ネイティブモード。未作成の場合のみ）
#    既に Firestore コンソールで作成済みならスキップ可。
gcloud firestore databases create --location=asia-northeast1 --project aruku-app

# 2. IP ハッシュ化用の HMAC 鍵を登録（32 文字以上。functions デプロイ前に必須）。
#    未登録だとレート制限は逆引き可能な文書を書かずフェイルオープン（通過）する
#    ため、濫用防止が実質無効化される。本番では必ず登録する。
printf '%s' "$(openssl rand -hex 32)" | \
  npx -y firebase-tools@latest functions:secrets:set RATE_LIMIT_HMAC_KEY --data-file -

# 3. セキュリティルールをデプロイ（rateLimits を含む全コレクションを
#    クライアントから全面拒否。Admin SDK のみがアクセスする）
npx -y firebase-tools@latest deploy --only firestore:rules

# 4. TTL ポリシーを設定し、期限切れドキュメントを自動削除（無限増殖を防止）
gcloud firestore fields ttls update expireAt \
  --collection-group=rateLimits --enable-ttl --project aruku-app

# 5. 設定が反映されたか確認（state が ACTIVE になっていれば有効）
gcloud firestore fields ttls list --collection-group=rateLimits --project aruku-app
```

手順 4 はコンソール操作でも設定可能なため、コードからは実施済みかどうか判別できません。
定期的に手順 5 で `state: ACTIVE` を確認してください（Issue #161）。

#### プロビジョニングが実際に効いているかの確認

上記の手順 1・2 はどちらも、**未実施でもアプリは正常に動いたまま**レート制限だけが黙って無効になります
（フェイルオープン）。実際 Issue #301 では、本番の Cloud Firestore API が未有効のまま全リクエストが
フェイルオープンし続けていました。デプロイ後は必ず以下で「有効になっていること」を確認してください。

```bash
# Firestore API が有効か（#301 の直接原因。無効ならレート制限は常時フェイルオープン）
gcloud services list --enabled --project aruku-app | grep firestore.googleapis.com

# (default) データベースが実在するか。API 有効化とデータベース作成は別物で、
# API だけ有効／DB 未作成なら NOT_FOUND となり、やはり常時フェイルオープンする。
gcloud firestore databases describe --project aruku-app

# HMAC 鍵が登録されているか（未登録でも同じくフェイルオープンする）
npx -y firebase-tools@latest functions:secrets:access RATE_LIMIT_HMAC_KEY | wc -c  # 32以上

# 設定不備由来のフェイルオープンが出ていないか（1件でもあれば保護は無効）
gcloud logging read \
  'jsonPayload.event="rate_limit" AND jsonPayload.decision="fail-open" AND jsonPayload.reason="config"' \
  --project aruku-app --freshness=1h --limit=5
```

最後のクエリは恒常的な監視にもなります。`reason="config"` は設定するまで解消しないため、
`docs/ops/observability.md` §6.1 で P1 アラートの対象としています。

ドキュメントは `{ count, resetAt, expireAt }` を持ち、`expireAt`（Timestamp）が TTL の対象です。
Firestore 呼び出しが失敗した場合はフェイルオープン（リクエスト通過）し、`console.error` に記録します。
一次の濫用防止は App Check が担うため、レートリミッタ障害でプロキシ全体が停止することはありません。

フェイルオープンのログには理由（`reason`）が付きます。`config` は設定不備で**恒久的に**保護が無効な状態、
`transient` は競合・一時不通で自然に解消しうる状態です。後者は下記「制約・トレードオフ」のとおり設計上
許容しているため、両者を混ぜるとアラートがノイズ化し、前者を取り逃します（Issue #301）。

### 制約・トレードオフ

- **同一 IP バースト時の挙動**: 同一 IP は同日中は常に同一ドキュメント `rateLimits/{HMAC(IP)}` を更新するため、
  バースト時にトランザクションがホットドキュメント上で競合します。Firestore の自動リトライが枯渇すると
  例外となりフェイルオープン（通過）するため、最も制限したいバースト局面で上限が緩む可能性があります。
  これは設計上許容しており、その局面の一次防御は App Check が担います。
- **レイテンシ・コスト**: 各プロキシ呼び出しごとに Firestore トランザクション（1 read + 1 write）が発生し、
  呼び出しレイテンシと Firestore 課金が増えます。課金 API の濫用防止という保険のためのコストです。
