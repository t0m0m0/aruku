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
