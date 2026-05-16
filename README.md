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

> CI など、ファイルを置かない環境では環境変数 `MAPS_API_KEY` でも代用できます。

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

## 秘匿情報の取り扱い

| ファイル | 追跡 | 内容 |
|---|---|---|
| `secrets.properties.example` / `ios/Flutter/Secrets.xcconfig.example` | あり | テンプレート（プレースホルダのみ）|
| `secrets.properties` / `ios/Flutter/Secrets.xcconfig` | なし（gitignore）| 実キー。コミット禁止 |
