# 本番リリース セキュリティハードニング 手順書

- **関連 Issue:** #75
- **最終更新:** 2026-06-09
- **対象:** 公開前に実施すべきセキュリティ対策のチェックリストと実施手順

このドキュメントは Issue #75 の4項目について、**コードで完結しない手動・運用作業の手順**と、
**証明書ピンニングの検討結果**をまとめる。各項目の進捗は Issue #75 のチェックボックスと同期する。

| # | 項目 | 種別 | 状態 |
|---|---|---|---|
| ① | API キーのアプリ制限 + API 制限 | 手動（GCP Console） | ⬜ 未実施 |
| ② | App Check enforcement 確認 | 手動（Firebase Console） | ⬜ 未実施 |
| ③ | TLS 証明書ピンニングの検討 | 設計判断 | ✅ 検討完了（当面見送り） |
| ④ | リリースビルドの本番署名鍵・production dart-define 確認 | 一部コード済 + 手動検証 | 🟡 署名分離済(PR #87) / 実ビルド検証が残 |
| ⑥ | Firestore クラウド同期のルール デプロイ | 一部コード済 + 手動デプロイ | 🟡 ルール実装済(PR #98) / Firestore 有効化・デプロイが残 |

---

## ① API キーのアプリ制限 + API 制限（GCP Console）

**目的:** API キーはアプリバイナリに埋め込まれる前提のため、デコンパイルで抽出されても
他用途に転用できないよう、キーに「呼び出せるアプリ」と「呼び出せる API」の二重制限をかける。

> 補足: 地図表示用キー（`google_maps_flutter` が `AndroidManifest.xml` / `Info.plist` から
> 読むキー）はアプリ内に存在せざるを得ない（ADR-001 参照）。Directions/Places 等の REST 系は
> Cloud Functions プロキシ側に隔離済みのため、ここで制限する主対象は **地図表示用キー**。

### 手順

1. [GCP Console > API とサービス > 認証情報](https://console.cloud.google.com/apis/credentials) を開く。
2. 対象 API キーを選択する。
3. **アプリケーションの制限** を設定:
   - **Android アプリ**: パッケージ名 `com.aruku.aruku` と **本番署名鍵の SHA-1** を登録。
     SHA-1 は本番 keystore から取得する:
     ```sh
     keytool -list -v -keystore ~/aruku-release.jks -alias aruku
     # 表示される SHA1: の値を登録（debug 用ではなく release 用を使うこと）
     ```
   - **iOS アプリ**: Bundle ID を登録。
4. **API の制限** を設定:
   - 「キーを制限」を選び、**実際に使用する API のみ**を許可
     （Maps SDK for Android / iOS, Places API, Routes API など。未使用 API は外す）。
5. 保存後、本番ビルドで地図・各機能が正常動作することを確認する。

### 検証

- 制限後、登録外のパッケージ/Bundle ID からの呼び出しが拒否されること（別アプリでキーを使うと 403）。
- 正規アプリからの地図表示・ルート検索が引き続き動作すること。

---

## ② App Check enforcement の確認（Firebase Console / Functions）

**目的:** Cloud Functions プロキシが App Check トークンを**必須化（enforce）**しており、
正規アプリ以外からの呼び出し（API 課金の濫用）を遮断できていることを確認する。

> アプリ側は `AppCheckHttpClient`（`lib/core/services/app_check_http_client.dart`）が
> 全リクエストに `X-Firebase-AppCheck` ヘッダを付与済み。残るは**サーバー側の enforce 設定確認**。

### 手順

1. [Firebase Console > App Check](https://console.firebase.google.com/) を開く。
2. **Apps** タブで Android / iOS が登録され、Attestation provider（Play Integrity / DeviceCheck/App Attest）が
   設定されていることを確認。
3. **APIs** タブで対象（Cloud Functions 等）が **Enforced** になっていることを確認。
   - `Monitor`（計測のみ）ではなく `Enforce`（遮断）であること。
4. Functions 側コードで App Check トークン検証が有効か確認:
   - Callable: `enforceAppCheck: true`
   - HTTP request: リクエストの `X-Firebase-AppCheck` ヘッダを検証し、無効なら 401 を返す。

### 検証

- トークン無しでプロキシを直接叩くと **401** が返ること。
- 正規アプリからの呼び出しは通ること。
- 注意: invoker（`allUsers`）が欠落していると App Check 到達前に **403** で弾かれる。
  401（App Check 拒否）と 403（invoker/権限）を区別して切り分けること。

---

## ③ TLS 証明書ピンニングの検討結果 → 当面見送り

### 検討内容

証明書ピンニングは、アプリに通信相手の証明書/公開鍵の指紋を焼き込み、OS の信頼ストアに
依存せず一致する相手としか通信しない防御策。中間者攻撃（不正 CA・端末への悪意ある CA 注入）
への耐性を高める。

### 結論: **当面実装しない**

主たる通信先が **Google 管理の Cloud Functions / Cloud Run**（`*.cloudfunctions.net` /
`*.run.app`）であることが決定的な理由。

- Google は証明書・公開鍵を**短期間で自動ローテーション**する。リーフ/中間証明書をハードピンすると、
  ローテーション時に**全ユーザーが一斉に通信不能になる自爆的な本番障害**を招くリスクが高い。
- 濫用対策は **① API キー制限**と **② App Check enforcement** で実質的に担保されており、
  ピンニングの追加便益は限定的。
- Issue #75 の文言も「ピンニングの**検討**」であり、実装必須ではない。

### 再検討の条件（将来）

以下に該当する通信先が増えた場合は、その通信先に限定して **SPKI（公開鍵）ピン**を再検討する:

- 自前管理ドメイン（証明書・鍵のローテーションを自分で制御できる）への直接通信が発生した場合。
- バックアップピン（次期鍵）を併用したローテーション運用を整備できる場合。

---

## ④ リリースビルドの署名鍵・dart-define 確認

**目的:** リリースビルドが **debug keystore ではなく本番署名鍵**で、かつ **production の
dart-define**（`PROXY_BASE_URL` 等）で生成されることを確認する。

### 現状

- 署名鍵の分離は **PR #87 で対応済み**。`android/key.properties` があれば本番 keystore で
  `release` を署名し、未配置の開発環境では debug 鍵にフォールバックする
  （`android/app/build.gradle.kts`）。
- 残るは **Android SDK 環境での実ビルド検証**（本ドキュメント作成環境では未実施）。

### 手順（Android SDK のある環境で実施）

1. 本番 keystore と `android/key.properties` を配置する（`android/key.properties.example` 参照）。
2. 署名構成を確認:
   ```sh
   cd android && ./gradlew :app:signingReport
   # release バリアントの Store が debug.keystore ではなく本番 keystore を指すこと
   ```
3. production の dart-define を与えてリリースビルド:
   ```sh
   flutter build appbundle --release \
     --dart-define=PROXY_BASE_URL=https://asia-northeast1-{projectId}.cloudfunctions.net
   # 必要に応じ USE_REAL_MAP 等も付与
   ```
4. 生成された AAB の署名を確認:
   ```sh
   jarsigner -verify -verbose -certs build/app/outputs/bundle/release/app-release.aab
   # 本番証明書（debug でない）で署名されていること
   ```

### 検証

- `signingReport` の release が本番 keystore を指す。
- AAB が本番証明書で署名されている。
- アプリが本番プロキシ URL へ通信する（debug/ローカル URL でない）。

---

## ⑥ Firestore クラウド同期のセキュリティ（ルール デプロイ）

**目的:** Issue #19 のクラウド同期で、クライアント SDK が `userSync/{uid}` ドキュメントを
直接読み書きするようになった。**本人以外がアクセスできない**ことを保証し、公開前に
セキュリティルールをデプロイする。

> アプリ側は `FirestoreSyncService`（`lib/core/services/sync_service.dart`）が
> `userSync/{uid}` 1 ドキュメントに同期する。`firestore.rules` は既定で全面拒否を維持しつつ、
> `userSync/{uid}` のみ `request.auth.uid == uid` の本人に read/write を許可済み。

### 手順

1. Firebase Console / CLI で **Firestore データベースを有効化**する（未作成の場合）。
2. ルールをデプロイする:
   ```sh
   npx -y firebase-tools@latest deploy --only firestore:rules --project aruku-app
   ```
3. インデックスが必要なクエリは無い（単一ドキュメント get/set のみ）が、念のため
   `firestore.indexes.json` も併せてデプロイする場合は `--only firestore` を使う。

### 検証

- 認証済みユーザー A が自分の `userSync/{A}` を読み書きできること。
- ユーザー A が他人の `userSync/{B}` を読み書きできないこと（`permission-denied`）。
- 未認証クライアントが `userSync/*` にアクセスできないこと。
- 既存のサーバ専用コレクション（`rateLimits` 等）がクライアントから引き続き全面拒否であること。

### 今後の硬化候補（任意）

- ルールでドキュメントサイズ/フィールドを検証する（例: `request.resource.size() < N`）。
  自分のドキュメントへの過大書き込み（自クォータ内）を抑止する。
- App Check を **Firestore** にも enforce する（現状は Cloud Functions のみ enforce、②参照）。

---

## ⑤ Functions リージョン移行手順（us-central1 → asia-northeast1）

**目的:** Issue #79 で Functions を `asia-northeast1` に明示デプロイした。リージョンを
変更すると Firebase は別の関数とみなすため、**旧 `us-central1` 関数は自動削除されない**。
以下を**安全な順序**で実施する（先に旧関数を消すと配布済みアプリが 404 になる）。
プロジェクト ID は `aruku-app`（`.firebaserc` の default）。コマンド例は実値を
記載しているが、URL 例中の `{projectId}` プレースホルダも同値に読み替える。

1. 新リージョンへデプロイ:
   ```sh
   cd functions && npm run build && cd ..
   npx -y firebase-tools@latest deploy --only functions --project aruku-app
   ```
   この時点では旧 `us-central1` の関数も残り、両リージョンが並存する。

2. クライアントの `PROXY_BASE_URL` を新リージョンへ切り替えてリリースビルドする
   （④ の手順）。URL は `https://asia-northeast1-{projectId}.cloudfunctions.net`。
   CI でビルドしている場合は CI 側の dart-define も更新する。

3. 配布が行き渡り、新リージョン関数の稼働と `allUsers` invoker 権限を確認したら、
   旧 `us-central1` 関数を**手動削除**する:
   ```sh
   npx -y firebase-tools@latest functions:delete \
     navitimeProxy googleWalkProxy \
     --region us-central1 --project aruku-app
   ```

4. 削除を確認する:
   ```sh
   npx -y firebase-tools@latest functions:list --project aruku-app
   # us-central1 の関数が消え、asia-northeast1 のみ残ること
   ```

### 注意

- 2nd gen Functions の実体は Cloud Run。残骸が無いか
  `gcloud run services list --region us-central1 --project aruku-app` で確認する。
- 新リージョン関数で `allUsers` invoker 権限が欠落すると App Check 検証前に 403 になる
  （② の検証参照）。
