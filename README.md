# aruku（あるく）

「電車に乗らず、時間内で最大限歩く」ルート案内アプリ（Flutter）。

## Google Maps セットアップ

地図・ルート・検索機能は Google Maps Platform の API キーを必要とします。
**平文キーは絶対にコミットしないでください**（`secrets.properties` /
`ios/Flutter/Secrets.xcconfig` は `.gitignore` 済み）。

### 1. API キーの発行

[Google Cloud Console](https://console.cloud.google.com/) で以下を有効化し、
API キーを 1 つ発行します（Android / iOS 共通の単一キーを使用）。

- Maps SDK for Android
- Maps SDK for iOS
- （後続機能用に Directions API / Places API も同時に有効化推奨）

### 2. キーファイルの配置

テンプレートをコピーして実キーを設定します。

```sh
cp secrets.properties.example secrets.properties
cp ios/Flutter/Secrets.xcconfig.example ios/Flutter/Secrets.xcconfig
```

両ファイルの `MAPS_API_KEY` に **同じキー** を設定します。

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

### 3. ビルド・実行

```sh
flutter pub get
flutter run
```

キー未設定でもアプリは起動し、地図はスタイライズド・プレースホルダで描画されます。

### 4. 実地図（GoogleMap）の表示

キー設定後、`USE_REAL_MAP` フラグを付けると実地図が表示されます。

```sh
flutter run --dart-define=USE_REAL_MAP=true
```

（既定では実地図を有効化しません。地図 UI の本格統合・テーマ適用は別 ISSUE で対応します）

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

## 秘匿情報の取り扱い

| ファイル | 追跡 | 内容 |
|---|---|---|
| `secrets.properties.example` / `ios/Flutter/Secrets.xcconfig.example` | あり | テンプレート（プレースホルダのみ）|
| `secrets.properties` / `ios/Flutter/Secrets.xcconfig` | なし（gitignore）| 実キー。コミット禁止 |
| `android/key.properties.example` | あり | テンプレート（プレースホルダのみ）|
| `android/key.properties` / `*.jks` / `*.keystore` | なし（gitignore）| 署名鍵。コミット禁止 |
