# 本番リリース セキュリティハードニング 手順書

- **関連 Issue:** #75
- **最終更新:** 2026-08-25
- **対象:** 公開前に実施すべきセキュリティ対策のチェックリストと実施手順

このドキュメントは Issue #75 の4項目について、**コードで完結しない手動・運用作業の手順**と、
**証明書ピンニングの検討結果**をまとめる。各項目の進捗は Issue #75 のチェックボックスと同期する。

| # | 項目 | 種別 | 状態 |
|---|---|---|---|
| ① | API キーのアプリ制限 + API 制限 | 手動（GCP Console） | ⬜ 未実施 |
| ② | App Check enforcement 確認 + リプレイ保護 | 手動（Firebase Console） + コード | 🟡 リプレイ保護は places/matrix に実装済（#366） / Console 確認・徒歩系の再生対策が残 |
| ③ | TLS 証明書ピンニングの検討 | 設計判断 | ✅ 検討完了（当面見送り） |
| ④ | リリースビルドの本番署名鍵・production dart-define 確認 | 一部コード済 + 手動検証 | 🟡 署名分離済(PR #87) / 実ビルド検証が残 |
| ⑥ | Firestore クラウド同期のルール デプロイ | 一部コード済 + 手動デプロイ | 🟡 ルール実装済(PR #98) / Firestore 有効化・デプロイが残 |
| ⑧ | Functions プロキシの CORS Origin 許可リスト | コード | ✅ 実装済（#359） |

---

## ① API キーのアプリ制限 + API 制限（GCP Console）

**目的:** API キーはアプリバイナリに埋め込まれる前提のため、デコンパイルで抽出されても
他用途に転用できないよう、キーに「呼び出せるアプリ」と「呼び出せる API」の二重制限をかける。

> 補足: 地図表示用キー（`google_maps_flutter` が `AndroidManifest.xml` / `Info.plist` から
> 読むキー）はアプリ内に存在せざるを得ない——ネイティブ Maps SDK が起動時にキーを読んで
> 直接タイルを取得するため、アプリコードで制御できない。Routes/Places 等の REST 系は
> Cloud Functions プロキシ側に隔離済みのため、ここで制限する主対象は **地図表示用キー**。

### 手順

**本番は4本（Android / iOS / Web / プロキシ）に分ける。制限の掛け方が違うので、混ぜないこと。**
ローカル開発用の Web キーを別に1本持つため、手元では計5本になる（理由は④）。

**1本のキーにアプリケーション制限は1種類しか設定できない**（Android アプリ制限と iOS アプリ制限を
同じキーに併記することはできない）ため、地図表示用キーはプラットフォームごとに分ける必要がある。
これは Google の[セキュリティ ガイダンス](https://developers.google.com/maps/api-security-best-practices)
が示すベストプラクティスでもある。

| キー | 使う主体 | 置き場所 | アプリケーションの制限 | API の制限 |
|---|---|---|---|---|
| 地図表示用（Android） | アプリ（Maps SDK） | `secrets.properties` | Android: パッケージ名 + SHA-1 | **Maps SDK for Android のみ** |
| 地図表示用（iOS） | アプリ（Maps SDK） | `ios/Flutter/Secrets.xcconfig` | iOS: Bundle ID | **Maps SDK for iOS のみ** |
| 地図表示用（Web・本番） | ブラウザ（Maps JavaScript API） | 公開ビルドの `MAPS_WEB_API_KEY` | ウェブサイト: 配信ドメインのみ | **Maps JavaScript API のみ** |
| 地図表示用（Web・開発） | ブラウザ（Maps JavaScript API） | ローカルの `dart_defines.json` | ウェブサイト: `localhost`（下記のとおり防御にならない） | **Maps JavaScript API のみ** |
| プロキシ用（`GOOGLE_MAPS_API_KEY`） | Cloud Functions | Secret Manager | **なし**（下記） | **Places API (New) + Routes API のみ** |

1. [GCP Console > API とサービス > 認証情報](https://console.cloud.google.com/apis/credentials) を開く。
2. **地図表示用キー（Android）** を選択し、次を設定する。
   - **アプリケーションの制限**: 「Android アプリ」→ パッケージ名 `com.aruku.aruku` と
     **本番署名鍵の SHA-1** を登録。SHA-1 は本番 keystore から取得する:
     ```sh
     keytool -list -v -keystore ~/aruku-release.jks -alias aruku
     # 表示される SHA1: の値を登録（debug 用ではなく release 用を使うこと）
     ```
   - **API の制限**: 「キーを制限」→ **Maps SDK for Android のみ**。
   - このキーは `secrets.properties` に入れる。
3. **地図表示用キー（iOS）** を選択し、次を設定する。
   - **アプリケーションの制限**: 「iOS アプリ」→ Bundle ID を登録。
   - **API の制限**: 「キーを制限」→ **Maps SDK for iOS のみ**。
   - このキーは `ios/Flutter/Secrets.xcconfig` に入れる。
   - 地図表示用キーはいずれもアプリバイナリから抽出できる前提なので、地図タイル取得以外に転用させない。
4. **地図表示用キー（Web）** は開発用と本番用で**別のキーを作る**。同じキーを使い回しては
   ならない——`localhost` を許可リストに含めたキーは、キーの文字列を知っている者なら
   誰でも使える。`localhost` は誰のマシンにもあり所有を証明しないため、公開バンドルに
   載るキーへ入れるとリファラー制限が丸ごと無効になる。

   **開発用キー**
   - **アプリケーションの制限**: 「ウェブサイト」→ `http://localhost:5555/*`。
     `flutter run -d chrome` はポートが毎回変わるため `--web-port=5555` で固定する。
     5000 は macOS の AirPlay レシーバー（ControlCenter）が、5001 は Functions
     エミュレータが使うため避ける。
   - ローカルの `dart_defines.json` にだけ置き、**デプロイ成果物に載せない**。
   - このキーの防御はリファラー制限ではなく「公開しないこと」である。上記のとおり
     `localhost` の登録は誰でも名乗れるので防御にならない。漏洩時の被害を頭打ちに
     するため、**1日あたりのクォータ上限を低く**掛けておくこと。

   **本番用キー**
   - **アプリケーションの制限**: 「ウェブサイト」→ 配信ドメインのみ。**`localhost` を入れない。**
   - 公開ビルドの `MAPS_WEB_API_KEY` にはこちらを渡す。
   - 配信先は Cloudflare Pages（README「Web 公開（Cloudflare Pages）」）。登録するのは
     `aruku.pages.dev/*` か独自ドメインで、**`*.pages.dev` を入れてはならない。**
     `pages.dev` は Cloudflare の全ユーザーが自分のプロジェクトを持つ共有サフィックスで、
     ワイルドカードで許可すると誰でも自分の Pages からこのキーを使えてしまう。
     `localhost` と同じく「所有を証明しないドメイン」であり、防御にならない。
   - 同じ理由で **PR ごとのプレビュー配信を作らない**。プレビューはデプロイのたびに
     サブドメインが変わり、個別に登録して追随することができない。

   **共通**
   - **API の制限**: 「キーを制限」→ **Maps JavaScript API のみ**。
   - **Web の地図キーは秘匿できない。** dart-define はコンパイル時定数として
     `main.dart.js` に焼き込まれ、ブラウザから読める。`web/index.html` へ直書き
     しないのは public リポジトリの履歴に残さないためであって、露出は同じ。
   - リファラー制限は `Referer` ヘッダを見ているだけで、ブラウザ外からは偽装できる。
     ネイティブの署名ベースの制限より構造的に弱いため、**GCP 側の予算アラートと
     1日あたりのクォータ上限**を併せて掛けること。本番用キーでも省けない。

5. **プロキシ用キー**を選択し、次を設定する。
   - **アプリケーションの制限**: **設定しない**。
     - Android/iOS アプリ制限は使えない（呼び出し元は Cloud Functions でありアプリではない）。
     - **IP アドレス制限も使えない。** プロキシは 2nd gen Cloud Functions（Cloud Run）で、
       VPC 下り + Cloud NAT を構成しない限り**下り IP が固定されない**。本リポジトリはその構成を
       持たないため、IP を許可リストに入れると Places / Routes の呼び出しが落ちる。
     - 固定 IP で縛りたい場合は、先に VPC 下り + Cloud NAT を構成して静的 IP を用意する必要がある
       （インフラ追加の判断であり、本手順の範囲外）。
   - **API の制限**: 「キーを制限」→ **Places API (New) + Routes API のみ**。
     アプリケーション制限を掛けられない分、**このキーの防御は API 制限が主**になる。
   - 併せて働く保護: キー自体は Secret Manager にありアプリへ出ない、プロキシは App Check 必須（②）、
     IP 単位のレート制限（README）。
6. 保存後、本番ビルドで地図・各機能が正常動作することを確認する。

### 検証

- **地図表示用キー**: 登録外のパッケージ/Bundle ID からの呼び出しが拒否されること（別アプリでキーを使うと 403）。
  **Android 用キーと iOS 用キーを取り違えていないこと**も確認する（取り違えるとそのプラットフォームで
  地図だけが出ない。制限が効いている状態と区別がつきにくい）。
- **プロキシ用キー**: 制限後も `placesProxy` / `googleWalkProxy` / `googleWalkMatrixProxy` が 200 を返すこと。
  API 制限を絞りすぎると上流が 403 を返すが、プロキシはこれを **502** に変換して上流ボディを素通しする
  （`functions/src/index.ts` の `UPSTREAM_FAILED` 経路）。アプリ側からは「検索できない」としか見えず
  原因が読めないため、構造化ログの `search_request`（`status="failure"`・`httpStatus=403`）で確認する
  （`docs/ops/observability.md` §2）。
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

### リプレイ保護（limited-use トークン）

トークンを持っていることの証明だけでは、**抜き取ったトークンの再送**を止められない。
Web 版ではトークンがブラウザの DevTools から読め、TTL の間そのまま再利用できる
（ネイティブの Play Integrity / App Attest では実質不可能だったことが、Web では
利用者の誰にでもできる）。攻撃者は自分のサーバーから curl でプロキシを叩ける。

対策は**使い捨てトークン**（`getLimitedUseToken()` + `verifyToken(token, {consume:true})`）。
ただし全エンドポイントには広げられない。**対象はクォータで決まる。**

| エンドポイント | 1検索あたりの本数 | トークン | 理由 |
| --- | --- | --- | --- |
| `googleWalkMatrixProxy` | 約11 | 使い捨て | 要素数課金で最も高単価（#155） |
| `placesProxy` | 3〜5 | 使い捨て | 本数が少なくクォータ影響が小さい（#366） |
| `googleWalkProxy` | **約21** | 標準（キャッシュ可） | 下記のとおりクォータを最も速く食う |

本数は `docs/spec/route-optimization.md` §3.8 の実測（`walkCalls=21 matrixCalls=11`）による。

#### なぜ `googleWalkProxy` を対象外にするか

使い捨てトークンは要求ごとに**新規アテステーションを強制**し、その回数はアテステーション
事業者のクォータを直接消費する。Firebase は「App Check の利用は事業者のクォータと制限に
従う。例: Play Integrity は Standard ティアで **1日 10,000 コール**」と明記している。

徒歩プロキシを対象に含めると 1 検索あたり 30 本超になり、**全ユーザー合計で 1日 300 検索
程度**でクォータが尽きる。枯渇するとクライアントの `getLimitedUseToken()` が throw し、
`AppCheckHttpClient` の catch がヘッダを落とし、結果として**そのプロキシは全要求 401**——
防ごうとした課金リスクより大きな可用性リスクを買うことになる。

Firebase 自身も「replay protection は往復が増えるため、**特に機微なエンドポイントに限って**
有効化する」ことを推奨している。

徒歩プロキシの再生対策は、アテステーションを消費しない方向（トークン単位のレート制限＝
盗んだトークン1本を1ユーザー分の枠に縛る）で別途扱う。

#### クライアントとサーバーの対応

- サーバー: `shouldConsumeAppCheckToken()`（`functions/src/index.ts`）
- クライアント: `AppCheckHttpClient.requiresLimitedUseToken()`（`lib/core/services/app_check_http_client.dart`）

**この2つは厳密に一致させること。** ずれは両方向とも実害がある。

- 対象を取りこぼして標準トークンを送る → サーバーが 2 回目以降を消費済みとして 401 →
  そのエンドポイントが壊れる。
- 非対象へ使い捨てトークンを送る → 毎回アテステーションを焼き、枯渇すれば同じく全要求 401。

#### 段階導入・緊急ロールバック

環境変数 `APP_CHECK_CONSUME_ENDPOINTS`（カンマ区切りの関数名）でサーバー側の対象を
上書きできる。設定は加算ではなく**置換**。

| 値 | 意味 |
| --- | --- |
| 未設定 | 既定（`placesProxy,googleWalkMatrixProxy`） |
| `googleWalkProxy` | 列挙したものだけが対象。既定は効かない |
| 空文字列 | 全エンドポイントで consume しない（緊急停止） |

**この停止が何を救い、何を救わないか。** サーバー側の検証を変えるだけなので、
救えるのは「サーバーが弾いている」種類の障害に限る。

| 障害 | 停止で復旧するか |
| --- | --- |
| IAM 欠落（`firebaseappcheck.appCheckTokens.verify` が無く consume 検証が失敗） | ✅ する |
| 想定外のリプレイ誤検知 | ✅ する |
| アテステーション・クォータ枯渇 | ⚠️ **クライアント側の縮退と併せて**復旧する |

クォータ枯渇はクライアント側の障害である。`getLimitedUseToken()` が throw し、ヘッダが
落ち、サーバーは「トークン欠落」で 401 を返す——この経路は consume 設定を一切見ない。
そのため `AppCheckHttpClient` は**使い捨ての取得に失敗したら標準トークンへ縮退する**。
停止と縮退が揃って初めて完全復旧する。

停止していない状態でも縮退は劣化に留める: 1 回目は通り、同じトークンの 2 回目以降が
リプレイとして 401 になる（全要求 401 よりは良い）。

対象を増やすときは **クライアント先行リリース → アドプション待ち → サーバーで有効化** の順で
行う。モバイルの入れ替えは原子的ではないため、サーバーを先に有効化すると旧クライアントが
送るキャッシュ済み標準トークンが 1 回目で消費され、2 回目以降 401 になる。

#### 検証

- 対象エンドポイントに同じトークンで 2 回叩くと、2 回目が **401**
  （`App Check token already consumed`）になること。
- 対象外（`googleWalkProxy`）は同じトークンの再利用で 401 にならないこと。
- **デプロイ後は 401 率を必ず確認する。** `consume:true` は Functions のサービスアカウントに
  `firebaseappcheck.appCheckTokens.verify` を要求し、これが欠けると対象エンドポイントが
  **100% 失敗**する（`googleWalkMatrixProxy` で実際に踏んだ）。`app_check_denied` の
  `reason` が `invalid` に張り付いていたらこれを疑う。応急処置は
  `APP_CHECK_CONSUME_ENDPOINTS=""` での停止（上表のとおり IAM 欠落には効く）。

#### レイテンシとクォータの計測

`request_latency` イベント（`functions/src/metrics.ts`）の **`appCheckMs`** が
App Check 検証区間だけの所要時間。`totalLatencyMs` には上流 API のばらつきが乗るため、
`consume` が足した往復のコストはこちらで見る。endpoint 別に比較でき、`googleWalkProxy`
（consume なし）が対照になる。

アテステーションのクォータ消費量は Firebase Console の App Check 指標と、Play Integrity /
reCAPTCHA 側のクォータ画面で見る。**対象を増やす前に、現行の消費量と上限の余裕を必ず確認する。**

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

> **ステータス: ルールのみ先行整備・クライアント未実装（2026-08-08 確認）。**
> Issue #19 のクラウド同期はアプリ側が存在しない — `cloud_firestore` は `pubspec.yaml` の
> 依存にすら入っておらず、`userSync/{uid}` を読み書きするコードは `lib/` に無い
> （最後の残骸だった `sync_meta_repository.dart` は #353 で撤去）。**同期機能そのものの
> 公開前チェックとしては未着手。**
>
> ただし**この例外ルール自体は生きている**。ルールをデプロイした環境では、認証済み
> （匿名サインインを含む）ユーザーが自分の `userSync/{uid}` を read / create / update /
> delete できる（`firestore.rules` の `match /userSync/{uid}`）。公式クライアントがその
> 経路を使っていないだけで、コレクションが到達不能なわけではない。実装まで残すか
> 撤去するかは別判断（本節では扱わない）。

**目的:** クライアント SDK が `userSync/{uid}` を直接読み書きするようになったとき、
**本人以外がアクセスできない**ことを保証する。ルールとそのテストは先行して用意済みなので、
同期を実装する際はこの節の検証を満たしてから公開する。

> `firestore.rules` は既定で全面拒否を維持しつつ、`userSync/{uid}` のみ
> `request.auth.uid == uid` の本人に read/write を許可する。書き込みは `isValidSyncData`
> がトップレベルのキー集合・型・リスト長を検証する。ルールのテストは
> `functions/test/firestore-rules.test.ts`（`npm run test:rules`・JDK21 必須）。
>
> **要素の schema はルールではなくモデル側が正本。** ルールはリスト長と型しか見ないため、
> 各要素の形を決めているのは既存の serializer のほう:
>
> | キー | 正本 |
> | --- | --- |
> | `settings` | `AppSettings.toJson()`（`lib/core/models/app_settings.dart`） |
> | `recents` / `recentOrigins` | `RecentPlace.toJson()`（`lib/core/models/recent_place.dart`） |
> | `activity` | `DailyActivity.toJson()`（`lib/core/models/daily_activity.dart`） |
> | `updatedAt` | 送出元は未定（同期を実装するときに決める） |
>
> 同期を実装するときは、ルールテストの fixture ではなく上の serializer に合わせること。
> fixture はルールを通すだけの緩い形で、そちらを正本と取り違えると、受理はされるのに
> `fromJson` が読めないデータを書き込む。適用先は各リポジトリの `replaceAll`
> （`recents_repository.dart` / `activity_log_repository.dart`）。

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

> **ステータス: 完了済み（2026-07-27 確認）。** `functions:list` で `us-central1` の関数が
> 0 件、`asia-northeast1` のみ稼働していることを確認した。以下は再発時・別リージョンへの
> 移行時に再利用する手順であり、**いま実行すべき作業は無い**。
>
> 手順3のコマンドが列挙する関数名は「実行時点で旧リージョンに残っているもの」を指す。
> 過去に存在した関数（例: `navitimeProxy`・#330 で撤去）を後から足す必要はない——旧
> リージョンには既に何も残っていない。逆に**未完了の状態でこの節を編集するときは、
> 削除対象から関数名を落とさないこと**（落とすとその関数だけ旧リージョンに取り残される）。

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
     googleWalkProxy \
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

---

## ⑦ 関数を廃止するときの手順（**本番削除はマージ前に手で行う**）

エンドポイントをソースから消すだけでは**本番の関数は稼働し続ける**。廃止した関数は
未使用のまま公開され、Secret Manager 経由の上流アクセスも生きたまま残る。

さらに、**CI は関数の削除を自動では行えない。** `.github/workflows/deploy-functions.yml`
の deploy ジョブは

```
deploy --only functions,firestore --non-interactive
```

を `--force` 無しで実行する。ソースから消えた関数の削除には対話確認が要るため、
`--non-interactive` では**確認できずデプロイごと中断する**。`functions` と `firestore` を
1コマンドに束ねているので、**ルール・インデックスのデプロイまで巻き添えで止まる**。

`--force` を常設しない理由は、意図しない export の消失がそのまま本番関数の無確認削除に
なるため。**「削除は失敗して気付く」が既定として正しい**——その代わり、廃止のときだけ
人が明示的に消す。

### 手順

1. **マージ前**に本番から削除する（`--force` はこのコマンド単体の確認省略）:
   ```sh
   npx -y firebase-tools@latest functions:delete <関数名> \
     --region asia-northeast1 --project aruku-app --force
   ```
2. 削除を確認する:
   ```sh
   npx -y firebase-tools@latest functions:list --project aruku-app
   ```
3. ソース側の PR をマージする。CI の deploy は削除対象が既に無いので確認を求めず通る。
4. その関数専用の Secret があれば削除する:
   ```sh
   gcloud secrets delete <SECRET_NAME> --project aruku-app
   ```
5. 2nd gen の実体は Cloud Run なので残骸も確認する:
   ```sh
   gcloud run services list --region asia-northeast1 --project aruku-app
   ```

**順序の注意:** 1 と 3 の間に `functions/**` を触る別の変更が main へ入ると、その
デプロイが削除済みの関数を**作り直す**（ソースにまだ残っているため）。1 の直後に 3 を
済ませること。

---

## ⑧ Cloud Functions プロキシの CORS（Origin 許可リスト）

**目的:** 他サイトがブラウザ JS からプロキシを埋め込み、自サイトの訪問者のトラフィックで
Places / Routes の課金枠を食う経路を塞ぐ。#359（Web 配信）で導入した。

### 守るもの・守らないもの

CORS はブラウザが**レスポンスを読ませるか**を決める仕組みでしかなく、リクエストが
サーバーへ届くこと自体は止めない。curl やモバイルアプリは無視する。

したがって**認可の主体は依然として ②App Check** であり、許可リストは多層防御の1枚である。

具体的には、許可リストが潰せるのは「攻撃者が自分のサーバーを用意せず、訪問者のブラウザに
プロキシを叩かせる」変種だけ。**抜き取ったトークンをサーバーから再生する経路には無力**で、
そちらは ② の limited-use トークン（`consume:true`）が担う。
Origin ヘッダの無いリクエスト（モバイル・curl）はサーバー側では拒否せず、ACAO を
付けないだけにしている——拒否してもブラウザ以外には効かず、ネイティブ版が壊れるだけのため。

### 許可する Origin

`isAllowedOrigin()`（`functions/src/index.ts`）が判定する。

| Origin | 用途 |
| --- | --- |
| `https://aruku.pages.dev` | 本番配信（Cloudflare Pages） |
| `https://<hash>.aruku.pages.dev` | Cloudflare が各デプロイへ自動で割り当てる別名 |
| `localhost` / `127.0.0.1`（http・https、任意のポート） | ローカル開発（README の `flutter run -d chrome --web-port=5555`） |

`pages.dev` は誰でもプロジェクトを作れる共有ドメインのため、`evil.pages.dev` や
`evil-aruku.pages.dev` を通さないよう、ホスト名は URL として解析し完全一致か
サブドメインかだけで判定している。前方一致・部分一致に書き換えないこと。

サブドメインを許すのは ① の「`*.pages.dev` を入れてはならない」と矛盾しない。
① が禁じているのは Cloudflare 全ユーザーの共有サフィックスを許すことで、ここで
許可するのは `aruku.pages.dev` の下——このプロジェクトのデプロイだけが名乗れる
名前に限られる。PR ごとのプレビュー配信は `.github/workflows/deploy-web.yml` の
方針どおり作らないが、本番デプロイにも Cloudflare がハッシュ別名を割り当てるため、
サブドメイン形は本番だけの運用でも必要になる。

本番デプロイでも `localhost` を許可しているのは、開発手順がデプロイ済み Functions を
叩くため。localhost オリジンを持てるのは開発者自身の端末で動くページだけで、攻撃者が
被害者のブラウザに localhost を名乗らせることはできない。

### 配信ドメインを変えるとき

`CORS_ALLOWED_HOST`（`functions/src/index.ts`）を変更し、`functions/test/handler-integration.test.ts`
の「Origin 許可リスト」の許可・拒否ケースを併せて更新する。① の地図表示用キーの
HTTP リファラ制限（配信ドメインのみ）も同じタイミングで直す。

### 検証

- 許可 Origin のプリフライト（`OPTIONS`）が **204** と `Access-Control-Allow-Origin: <その Origin>`、
  `Access-Control-Max-Age: 3600` を返すこと。
- 許可外 Origin では ACAO が付かないこと（ステータスは 204 のままでよい）。
- `Vary: Origin` が Origin の有無にかかわらず付くこと。共有キャッシュが別オリジン向けの
  ACAO を使い回さないための前提。
