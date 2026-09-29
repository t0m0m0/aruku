# 本番リリース セキュリティハードニング 手順書

- **位置づけ:** 公開前および運用中に実施する**コードで完結しない手動・運用作業**の手順書。
- **進捗の正本は本書ではなく issue #75 のチェックボックス。** 本書は「どう実施するか」だけを書き、「実施したか」は書かない。
- **関連:** [route-optimization.md](spec/route-optimization.md) §2.1（プロキシの構成）, [ops/observability.md](ops/observability.md)（保護機構の監視）

| # | 項目 | 種別 |
|---|---|---|
| ① | API キーのアプリ制限 + API 制限 | 手動（GCP Console） |
| ② | App Check enforcement 確認 + リプレイ保護 | 手動（Firebase Console） + コード |
| ③ | TLS 証明書ピンニング | 設計判断 |
| ④ | 本番バンドルの設定確認 | 手動検証 + CI |
| ⑥ | Firestore のクライアントアクセス（ルール デプロイ） | CI デプロイ + 手動検証 |
| ⑦ | 関数を廃止するときの手順 | 手動（本番削除） |
| ⑧ | Functions プロキシの CORS Origin 許可リスト | コード |

---

## ① API キーのアプリ制限 + API 制限（GCP Console）

**目的:** 地図表示用キーは配信物（バンドル）に埋め込まれる前提のため、抜き出されても
他用途に転用できないよう、キーに「呼び出せる場所」と「呼び出せる API」の二重制限をかける。

> 補足: 地図表示用キーは配信物に存在せざるを得ない——ブラウザが Maps JavaScript API を
> 読み込むときにキーを渡して直接タイルを取得するため、アプリコードで隠せない。Routes/Places 等の
> REST 系は Cloud Functions プロキシ側に隔離済みのため、ここで制限する主対象は **地図表示用キー**。

### 手順

**本番は2本（地図表示用 Web / プロキシ）に分ける。制限の掛け方が違うので、混ぜないこと。**
ローカル開発用の Web キーを別に1本持つため、手元では計3本になる（理由は下の手順 2）。

> Flutter 版が使っていたキー3本（地図表示用 `MAPS_API_KEY` と、Firebase が自動作成した
> Android 用・iOS 用）は #387 で削除した（2026-09-29）。Android 用には撤去後も外部から
> 全件拒否のリクエストが届き続けていた。Firebase にアプリを登録するとキーが自動作成されるので、
> ネイティブアプリを復活させるときはここに行を足すこと。

| キー | 使う主体 | 置き場所 | アプリケーションの制限 | API の制限 |
|---|---|---|---|---|
| 地図表示用（Web・本番） | ブラウザ（Maps JavaScript API） | 公開ビルドの `VITE_MAPS_WEB_API_KEY`（GitHub の secret `MAPS_WEB_API_KEY`） | ウェブサイト: 配信ドメインのみ | **Maps JavaScript API のみ** |
| 地図表示用（Web・開発） | ブラウザ（Maps JavaScript API） | ローカルの `apps/web/.env` | ウェブサイト: `localhost`（下記のとおり防御にならない） | **Maps JavaScript API のみ** |
| プロキシ用（`GOOGLE_MAPS_API_KEY`） | Cloud Functions | Secret Manager | **なし**（下記） | **Places API (New) + Routes API のみ** |

1. [GCP Console > API とサービス > 認証情報](https://console.cloud.google.com/apis/credentials) を開く。
2. **地図表示用キー（Web）** は開発用と本番用で**別のキーを作る**。同じキーを使い回しては
   ならない——`localhost` を許可リストに含めたキーは、キーの文字列を知っている者なら
   誰でも使える。`localhost` は誰のマシンにもあり所有を証明しないため、公開バンドルに
   載るキーへ入れるとリファラー制限が丸ごと無効になる。

   **開発用キー**
   - **アプリケーションの制限**: 「ウェブサイト」→ `http://localhost:5173/*`（Vite の開発サーバの
     既定ポート）。5000 は macOS の AirPlay レシーバー（ControlCenter）が、5001 は Functions
     エミュレータが使うため、ポートを変えるときも避ける。
   - ローカルの `apps/web/.env` にだけ置き、**デプロイ成果物に載せない**。
   - このキーの防御はリファラー制限ではなく「公開しないこと」である。上記のとおり
     `localhost` の登録は誰でも名乗れるので防御にならない。漏洩時の被害を頭打ちに
     するため、**1日あたりのクォータ上限を低く**掛けておくこと。

   **本番用キー**
   - **アプリケーションの制限**: 「ウェブサイト」→ 配信ドメインのみ。**`localhost` を入れない。**
   - 公開ビルドの `VITE_MAPS_WEB_API_KEY`（React SPA、`apps/web`）にこちらを渡す。
   - 配信先は Cloudflare Pages（README「Web 公開（Cloudflare Pages）」）。登録するのは
     `aruku.pages.dev/*` か独自ドメインで、**`*.pages.dev` を入れてはならない。**
     `pages.dev` は Cloudflare の全ユーザーが自分のプロジェクトを持つ共有サフィックスで、
     ワイルドカードで許可すると誰でも自分の Pages からこのキーを使えてしまう。
     `localhost` と同じく「所有を証明しないドメイン」であり、防御にならない。
   - 同じ理由で **PR ごとのプレビュー配信を作らない**。プレビューはデプロイのたびに
     サブドメインが変わり、個別に登録して追随することができない。
   - **これを止めているのは Cloudflare 側の設定であって、ワークフローではない。**
     `.github/workflows/deploy-web.yml` は wrangler でしか配信しないが、Pages プロジェクトには
     Git 連携（GitHub App）が繋がっており、push を直接ビルドして配信する第二の経路がある。
     そちらはダッシュボードで Build command を設定した時点で、コードレビューを通らずに
     鍵入りのプレビューを `*.pages.dev` へ出す。Cloudflare は Git 連携済みプロジェクトを
     Direct Upload に戻せないため、経路を消すことはできない。Branch control で
     `Preview branch` を `None (Disable automatic branch deployments)` に、
     `Enable automatic production branch deployments` を OFF に保つこと
     （README「Web 公開（Cloudflare Pages）」）。

   **共通**
   - **API の制限**: 「キーを制限」→ **Maps JavaScript API のみ**。
   - **Web の地図キーは秘匿できない。** `VITE_` の値はビルド時に文字列リテラルへ
     差し替えられてバンドルに焼き込まれ、ブラウザから読める。追跡ファイルへ直書き
     しないのは public リポジトリの履歴に残さないためであって、露出は同じ。
   - リファラー制限は `Referer` ヘッダを見ているだけで、ブラウザ外からは偽装できる。
     ネイティブの署名ベースの制限より構造的に弱いため、**GCP 側の予算アラートと
     1日あたりのクォータ上限**を併せて掛けること。本番用キーでも省けない。

3. **プロキシ用キー**を選択し、次を設定する。
   - **アプリケーションの制限**: **設定しない**。
     - ウェブサイト制限は使えない（呼び出し元は Cloud Functions でありブラウザではない）。
     - **IP アドレス制限も使えない。** プロキシは 2nd gen Cloud Functions（Cloud Run）で、
       VPC 下り + Cloud NAT を構成しない限り**下り IP が固定されない**。本リポジトリはその構成を
       持たないため、IP を許可リストに入れると Places / Routes の呼び出しが落ちる。
     - 固定 IP で縛りたい場合は、先に VPC 下り + Cloud NAT を構成して静的 IP を用意する必要がある
       （インフラ追加の判断であり、本手順の範囲外）。
   - **API の制限**: 「キーを制限」→ **Places API (New) + Routes API のみ**。
     アプリケーション制限を掛けられない分、**このキーの防御は API 制限が主**になる。
   - 併せて働く保護: キー自体は Secret Manager にありアプリへ出ない、プロキシは App Check 必須（②）、
     IP 単位のレート制限（README）。
4. 保存後、本番ビルドで地図・各機能が正常動作することを確認する。

### 検証

- **地図表示用キー**: 登録外のオリジンからの呼び出しが拒否されること（`RefererNotAllowedMapError`）。
  **開発用キーと本番用キーを取り違えていないこと**も確認する（本番に開発用キーを渡すと
  `localhost` を許可したキーが公開される。逆だと本番で地図だけが出ない）。
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

> アプリ側は `AppCheckHttpClient`（`apps/web/src/http/app-check-http-client.ts`）が
> 全リクエストに `X-Firebase-AppCheck` ヘッダを付与する。本節が扱うのは**サーバー側の enforce 設定**。

### 手順

1. [Firebase Console > App Check](https://console.firebase.google.com/) を開く。
2. **Apps** タブで Web アプリが登録され、Attestation provider（reCAPTCHA v3）が
   設定されていることを確認。登録されているのは Web アプリ1つだけのはず。Flutter 版の
   Android / iOS アプリの登録は #387 で削除した（2026-09-29）。
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
- クライアント: `AppCheckHttpClient.requiresLimitedUseToken()`（`apps/web/src/http/app-check-http-client.ts`）

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

## ③ TLS 証明書ピンニング → 実装しない

主たる通信先が **Google 管理の Cloud Functions / Cloud Run**（`*.cloudfunctions.net` /
`*.run.app`）であることが理由。

- Google は証明書・公開鍵を**短期間で自動ローテーション**する。リーフ/中間証明書をハードピンすると、
  ローテーション時に**全ユーザーが一斉に通信不能になる自爆的な本番障害**を招く。
- 濫用対策は **① API キー制限**と **② App Check enforcement** で担保しており、
  ピンニングの追加便益は限定的。

### 実装する条件

以下に該当する通信先が増えた場合は、その通信先に限定して **SPKI（公開鍵）ピン**を再検討する:

- 自前管理ドメイン（証明書・鍵のローテーションを自分で制御できる）への直接通信が発生した場合。
- バックアップピン（次期鍵）を併用したローテーション運用を整備できる場合。

---

## ④ 本番バンドルの設定確認

**目的:** 配信されているバンドルが **本番の値**（`VITE_PROXY_BASE_URL`・本番用の地図キー等）で
作られ、**開発専用の値**（App Check デバッグトークン・`localhost` を許可した開発用キー）を
含まないことを確認する。

### 前提

`VITE_` の値はビルド時にバンドルへ焼かれる。本番ビルドは `.github/workflows/deploy-web.yml` が
GitHub の secrets / vars から組み、空の値があればビルド前に落とす。デバッグトークンが
本番バンドルへ入らないことは `apps/web/test/build/production-bundle.test.ts` が CI で
実際にビルドして見張る。**名前の取り違えと、開発用キーを本番の secret に入れる誤りは
どちらの検査も素通りする**ので、以下はそれを検出するためのもの。

### 手順

1. 配信中の `index.html` が参照するバンドルを取得する:
   ```sh
   curl -s https://aruku.pages.dev/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js'
   curl -s https://aruku.pages.dev/assets/index-<hash>.js -o bundle.js
   ```
2. プロキシの URL が本番を指すことを確認する:
   ```sh
   grep -o 'https://asia-northeast1-[a-z0-9-]*\.cloudfunctions\.net' bundle.js | sort -u
   ```
3. バンドルに入っている地図キーが**本番用キー**であることを GCP Console の認証情報と
   突き合わせる（キーの末尾数文字で照合し、キーそのものをどこかへ貼らない）。

### 検証

- プロキシの URL が本番（ローカルのエミュレータ URL でない）。
- 地図キーが本番用（許可リストに `localhost` を持たない）キーである。
- 本番の画面で地図・地点検索・経路検索が動く。

---

## ⑥ Firestore のクライアントアクセス（ルール デプロイ）

**目的:** Firestore はサーバ専用（Cloud Functions の Admin SDK だけが使う）とし、
クライアント SDK からの読み書きを**すべて**拒否した状態を本番に保つ。

> **クライアントに開いている経路は無い。** `firestore.rules` は全パスを `if false` で拒否する。
> 本番のクライアント（`apps/web`）は Firebase を App Check のためにしか使っておらず、
> Firestore も Auth も持たない。ルールのテストは `functions/test/firestore-rules.test.ts`
> （`npm run test:rules`・JDK21 必須）。
>
> かつてはクラウド同期のために `userSync/{uid}` を本人へ開けていた。同期のコードは #285 で
> 撤去したが、配布済みのクライアントを壊さないためにルールだけ残していた。UI から同期に
> 届いたのは 2026-06-09〜11 の開発ビルドだけで、配布された版は無い。そのため #387 で閉じた。

### 手順

1. Firebase Console / CLI で **Firestore データベースを有効化**する（未作成の場合。
   レートリミッタが使う）。
2. ルールは `main` へのマージで CI（`.github/workflows/deploy-functions.yml`）がデプロイする。
   手で入れる場合:
   ```sh
   npx -y firebase-tools@latest deploy --only firestore:rules --project aruku-app
   ```

### 検証

- 認証済みでも未認証でも、クライアントから任意のコレクションを読み書きできないこと
  （`permission-denied`）。`rateLimits` も含む。

### クライアント同期を作り直すとき

ルールを開く前に次を満たすこと。

- **App Check を Firestore にも enforce する**（現状は Cloud Functions のみ、②参照）。
  匿名サインインを許すと本人一致だけでは濫用を防げない——匿名アカウントは無制限に作れ、
  公開 API キーから REST で直接書ける。
- 旧ルール（本人一致＋トップレベルのキー集合・型・リスト長の検証）は `userSync` を閉じる
  直前の `firestore.rules` にある（`git log -- firestore.rules`）。ルールはリスト長と型しか
  見られないので、要素の形の正本はクライアントの serializer に置き、ルールテストの fixture は
  手で書き写さずその serializer から組み立てる（#257 の真因）。

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
| `localhost` / `127.0.0.1`（http・https、任意のポート） | ローカル開発（README の `npm --prefix apps/web run dev`） |

`pages.dev` は誰でもプロジェクトを作れる共有ドメインのため、`evil.pages.dev` や
`evil-aruku.pages.dev` を通さないよう、ホスト名は URL として解析し完全一致か
サブドメインかだけで判定している。前方一致・部分一致に書き換えないこと。

サブドメインを許すのは ① の「`*.pages.dev` を入れてはならない」と矛盾しない。
① が禁じているのは Cloudflare 全ユーザーの共有サフィックスを許すことで、ここで
許可するのは `aruku.pages.dev` の下——このプロジェクトのデプロイだけが名乗れる
名前に限られる。サブドメイン形が必要なのは、本番デプロイにも Cloudflare が
ハッシュ別名を割り当てるためで、プレビュー配信を想定しているからではない。

**ただしこの許可は、プレビューが出たときにそれも通してしまう。** ① のとおり
プレビューを止めているのは Cloudflare の Branch control であり、そこが緩むと
リファラー制限と Origin 許可リストの両方が同時に無効化される。この関数は
`aruku.pages.dev` の下という以上の区別をしないので、**プレビュー抑止の境界として
数えてはならない**。

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
