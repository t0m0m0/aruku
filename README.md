# aruku（あるく）

「電車に乗らず、時間内で最大限歩く」ルート案内アプリ。React + TypeScript の SPA で、
本番は `aruku.pages.dev`。

Flutter 版は #387 で撤去した。`flutter-final` タグと `archive/flutter` ブランチに残っている
（復元手順は [docs/archive/flutter-restore.md](docs/archive/flutter-restore.md)）。

## 構成

| ディレクトリ | 中身 | 正本 |
|---|---|---|
| `apps/web/` | React + Vite の SPA（本番が配信しているもの） | [apps/web/PORTING.md](apps/web/PORTING.md) |
| `packages/engine/` | 経路エンジン（TypeScript） | [ルート最適化 仕様](docs/spec/route-optimization.md)・[packages/engine/PORTING.md](packages/engine/PORTING.md) |
| `functions/` | Cloud Functions のプロキシ（Places・Routes）とレート制限 | [docs/security_hardening.md](docs/security_hardening.md) |

```bash
npm --prefix packages/engine ci
npm --prefix packages/engine run typecheck  # 型（CI もこれを回す）
npm --prefix packages/engine test           # 383 本すべて緑（CI もこれ）

npm --prefix apps/web ci
npm --prefix apps/web run typecheck  # 型（CI もこれを回す）
npm --prefix apps/web test           # CI もこれ
npm --prefix apps/web run build      # 本番バンドルの解決まで見る（CI もこれ）
npm --prefix apps/web run e2e        # Playwright（CI もこれ）
```

E2E は初回だけブラウザの取得が要る（`npm --prefix apps/web exec playwright install chromium`）。
自分でビルドしてプレビューを起こすので、`run build` とは別に走らせる。

Node は 22.22.0 以上が要る（`react-router` の要求）。`packages/engine` より厳しい。

決定（React Router 一本化・Zustand・workspaces を置かない理由）は
[apps/web/PORTING.md](apps/web/PORTING.md) が正本。

## セットアップ

### 1. API キーの発行

[Google Cloud Console](https://console.cloud.google.com/) で必要な API を有効化し、
キーを発行します。**平文キーは絶対にコミットしないでください**（`apps/web/.env` は
`.gitignore` 済み）。

| 用途 | API | 呼び出し元 | キーの置き場所 |
|---|---|---|---|
| 地図表示 | Maps JavaScript API | ブラウザ | `apps/web/.env` の `VITE_MAPS_WEB_API_KEY` |
| 徒歩の所要・距離・街路ジオメトリ | Routes API | `googleWalkProxy` / `googleWalkMatrixProxy` | Secret Manager `GOOGLE_MAPS_API_KEY` |
| 地点検索 | Places API (New) | `placesProxy` | Secret Manager `GOOGLE_MAPS_API_KEY` |
| 公共交通の経路 | — （Transit API・認証不要） | ブラウザから直接 | 不要 |

キーは地図表示用（ブラウザ）とプロキシ用（サーバー）に分けます。制限の掛け方は
[docs/security_hardening.md](docs/security_hardening.md) ① が正本です。

公共交通だけは Google ではなく Transit API（`https://api.transit.ls8h.com`）をブラウザから
直接呼ぶため、キーも API 有効化も要りません（[ルート最適化 仕様](docs/spec/route-optimization.md) §2）。

### 2. `.env` の用意

```sh
cp apps/web/.env.example apps/web/.env
```

各値の意味は `apps/web/.env.example` のコメントが正本です。`VITE_` の値はバンドルへ焼かれて
ブラウザから読めるので、秘匿値を置かないでください（例外は開発時だけ読む
`VITE_APP_CHECK_DEBUG_TOKEN` で、本番バンドルからは分岐ごと消える）。

**ここに入れるのは開発用キーです。** 開発用は許可リストに `localhost` を含めるため、
キーを知っている者なら誰でも使えます（`localhost` は誰のマシンにもあり所有を証明しない）。
本番のビルドには配信ドメインだけを許可した別のキーを渡します。分け方は
[docs/security_hardening.md](docs/security_hardening.md) ①④ が正本です。

### 3. 起動

```sh
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

- `VITE_PROXY_BASE_URL` が空だと起動時に落ちます（`createRouteService`）。
- `VITE_MAPS_WEB_API_KEY` が空なら実地図の読み込みを見送り、作り物の地図のままになります
  （起動は落ちません）。キーの HTTP リファラー制限に開発中のオリジン
  （例 `http://localhost:5173`）が無いと、実地図だけが `RefererNotAllowedMapError` で出ません。

## プロキシを動かす（地点検索・徒歩実測）

地点検索と徒歩実測は Cloud Functions プロキシ経由です。アプリはプロキシの URL を
`VITE_PROXY_BASE_URL` から読みます。

| 叩く先 | `VITE_PROXY_BASE_URL` |
|---|---|
| ローカルの Functions エミュレータ | `http://127.0.0.1:5001/{projectId}/asia-northeast1` |
| デプロイ済みプロキシ | `https://asia-northeast1-{projectId}.cloudfunctions.net` |

**デプロイ済みプロキシを叩くには App Check の設定が要ります。** 開発サーバ（`npm run dev`）は
常にデバッグプロバイダを使い、本番ビルドは reCAPTCHA v3 だけを使います
（`apps/web/src/firebase/app-check.ts`）。

準備するもの:

1. reCAPTCHA 管理コンソールで **reCAPTCHA v3** のサイトを登録し、配信ドメイン
   （ローカル開発なら `localhost`）を追加する。**サイトキーとシークレットキーの
   2つが発行される**
2. Firebase Console → **Security → App Check → Apps** タブでこの Web アプリに
   reCAPTCHA v3 プロバイダを登録する。ここに入れるのは**シークレットキー**
3. `apps/web/.env` の `VITE_RECAPTCHA_SITE_KEY` に**サイトキー**（公開鍵）を書く

**2 と 3 で入れる鍵は別物です。** Firebase 側はトークン検証にシークレットを使い、
アプリ側は `ReCaptchaV3Provider` にサイトキーを渡します。取り違えると検証が通りません。

> 開発サーバでは App Check のデバッグトークンを使います。`VITE_APP_CHECK_DEBUG_TOKEN` が空なら
> SDK がトークンを生成してブラウザのコンソールへ出し、IndexedDB に保存して次回からも使い回します。
> その値を Firebase Console → Security → App Check → Apps タブ → 対象アプリの ⋮ →
> **デバッグトークンを管理** に1回登録すれば通ります。保存はオリジン（ポートを含む）ごとなので、
> サイトデータを消す・ポートを変える・シークレットウィンドウで開くと作り直され、登録し直しが
> 要ります。ブラウザやポートを問わず同じ値を使いたいときだけ、登録した値を
> `VITE_APP_CHECK_DEBUG_TOKEN` に置きます。**デバッグトークンはコミットしないこと。**

**ローカルのエミュレータなら App Check は要りません。** `functions/src/index.ts` の
`verifyAppCheck` は `FUNCTIONS_EMULATOR` が立っているとき検証ごとスキップし、
プロキシの CORS 許可リスト（`isAllowedOrigin`）は `localhost` / `127.0.0.1` を
任意のポートで許可しています（プリフライト対応済み）。

> **現在地の取得はブラウザの許可が要ります。** `http://localhost` は secure context
> なので geolocation API 自体は使えますが、許可を拒否すると「位置情報なし」と表示されます
> （アプリ側の失敗ではありません）。一度拒否するとプロンプトは再表示されないため、
> サイト設定から許可し直してください。

**① Functions エミュレータを起動する。** `package.json` の `main` は `lib/index.js`
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

**② アプリを起動する。** `apps/web/.env` の `VITE_PROXY_BASE_URL` をエミュレータの URL に
してから、リポジトリのルートで `npm --prefix apps/web run dev` を実行します。

- エミュレータ実行時は App Check 検証とレート制限の Firestore 依存が外れるため、
  Firestore エミュレータは不要です（レート制限はインメモリ実装へフォールバック）。

## Web 公開（Cloudflare Pages）

`main` への push で `.github/workflows/deploy-web.yml` が `apps/web` の Vite ビルド
（`dist/`）を Cloudflare Pages へ配信します。静的配信先に Cloudflare を選んだのは、
転送量に上限のある無料枠（Firebase Hosting Spark は 10GB/月）だと先に頭を打つためです。
Vercel Hobby は帯域では足りますが ToS が非商用限定で、収益化（#238〜#240）と両立しません。

この理由は React へ移っても残ります。初回に必ず取るのは 620KB 前後（JS + CSS）ですが、
配信物の総量は 6MB 強——大半は同梱した日本語
フォントの分割 162 本（#386）で、`unicode-range` ごとに画面が実際に描く文字ぶんだけが
取られます。取る量が利用者数に比例する点は変わりません。

**配信の費用はこの構成では実質かかりません。** 課金が発生し得るのは Google Maps Platform
（SKU ごとの月間無料枠を超えた分）と Cloud Functions（Blaze）で、いずれも配信先の選択とは
無関係です。

### 1. Pages プロジェクトの作成

ワークフローはプロジェクトが既にある前提で `pages deploy` します。一度だけ作成します。

```sh
npx --yes wrangler@latest pages project create aruku --production-branch=main
```

名前を変える場合は `deploy-web.yml` の `PAGES_PROJECT` も合わせてください。

#### Git 連携の自動デプロイを止める（**必須**）

Pages プロジェクトに Cloudflare の Git 連携（GitHub App）が繋がっていると、**このワークフローを
通らない第二の配信経路**ができます。push が直接ビルド・配信され、PR レビューも下の
production Environment のゲートも効きません。Cloudflare は Git 連携済みプロジェクトを
Direct Upload に戻せない（[Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)）ため、
連携を切る形では閉じられません。`Workers & Pages → aruku → Build → Branch control` で
自動デプロイを両方止めます。

| 設定 | 値 | 止めているもの |
|---|---|---|
| `Enable automatic production branch deployments` | OFF | Git 連携のビルドが本番エイリアスを奪うこと |
| `Preview branch` | `None (Disable automatic branch deployments)` | PR ごとのプレビュー配信（鍵の露出。「4. 公開ドメインの登録」参照）|

この状態でも `wrangler pages deploy`（`deploy-web.yml` の deploy ジョブ）は従来どおり動きます。

production 側を止め忘れると、`deploy-web.yml` の paths フィルタに掛からない push——
`apps/web/**` `packages/engine/**` を触らない変更——のあと、Git 連携側のビルドが本番として
配信されます。
実際にこれで本番が空のデプロイに差し替わり、3日間 404 になりました（#392）。

### 2. GitHub 側の設定

**置き場所が2種類あります。取り違えると防御が無くなるので、表のとおりに分けてください。**

**(a) production Environment のシークレット**（Settings → Environments → production → Environment secrets）

| 名前 | 内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 権限「Cloudflare Pages: 編集」のみを持つ API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボード右側のアカウント ID |

**(b) リポジトリのシークレット / 変数**（Settings → Secrets and variables → Actions）

| 種別 | 名前 | 内容 |
|---|---|---|
| Secret | `FIREBASE_WEB_API_KEY` / `FIREBASE_WEB_APP_ID` | Firebase Console → プロジェクトの設定 → マイアプリ（Web）|
| Secret | `RECAPTCHA_SITE_KEY` | Web の App Check（reCAPTCHA v3）サイトキー。未設定だとプロキシが 401 |
| Secret | `MAPS_WEB_API_KEY` | **本番用**の Maps JavaScript API キー（開発用と使い回さない）|
| Variable | `PROXY_BASE_URL` | `https://asia-northeast1-{projectId}.cloudfunctions.net` |

分ける理由は、`workflow_dispatch` が main 以外の ref からも起動でき、**そのとき実行されるのは
その ref のワークフロー定義**だからです。ブランチ側でワークフローを書き換えれば、そこから
読めるシークレットはすべて取り出せます。したがって `deploy-web.yml` の
`if: github.ref == ...` は利便のための分岐であって、防御ではありません。

(a) の2つは配信を実行できる資格情報なので、Environment に置いて main 以外のジョブから
構造的に届かないようにします。(b) はバンドルへ焼かれてブラウザから読める値であり、
ブランチから参照できても権限の格上げになりません。

シークレット名に `VITE_` は付けません。Vite はその接頭辞の付いた環境変数しかバンドルへ
露出しないため、冠するのは `deploy-web.yml` が渡すときです（`VITE_MAPS_WEB_API_KEY:
${{ secrets.MAPS_WEB_API_KEY }}`）。

`PROXY_BASE_URL` だけ Variable なのは公開 URL で秘匿対象ではないためです。(b) はいずれも
未設定だと空文字がバンドルに焼かれて実行時に壊れるため、ワークフロー冒頭で存在検査をして
落とします。

### 3. production Environment の branch rule（**必須**）

Settings → Environments → production → Deployment branches and tags で **`main` のみ**を
許可します。**ルールの種別は「Branch」を選んでください**（「Tag」ではありません）。

これが実際に ref を縛る唯一の仕組みです。ワークフローファイル側の `if` はブランチから
書き換えられますが、Environment のルールは GitHub 側が強制するため、許可されていない ref から
`environment: production` のジョブを走らせようとするとゲートで拒否されます。

種別を指定するのは、名前パターンがブランチとタグで個別に設定されるためです。Branch 種別の
`main` は `refs/tags/main` に一致しないので、同名タグを作って dispatch する経路は塞がります
（Tag のルールを別途作らない限り、タグからは配信できません）。「Protected branches only」を
選ぶ形でも構いません——保護ブランチと同名のタグからの deployment は GitHub 側が拒否します。

同じ画面で required reviewers を設定すれば、配信前に承認を挟めます
（`deploy-functions.yml` と同じ環境です）。

### 4. 公開ドメインの登録

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

同じ理由で PR ごとのプレビュー配信を作りません。プレビューはデプロイのたびに
サブドメインが変わり、リファラー制限で追随できないためです。`deploy-web.yml` が
プレビューを作らないだけでは足りず、**「1. Pages プロジェクトの作成」の Branch control を
設定して初めて成立します**。Cloud Functions プロキシの Origin 許可リストは
`*.aruku.pages.dev` を通すので、プレビューが出れば CORS 側も素通りします
（[docs/security_hardening.md](docs/security_hardening.md) ⑧）。

### 5. マージ前の確認（dry run）

ワークフローは `build`（検査・テスト・ビルド）と `deploy`（配信）の2ジョブに分かれています。
`workflow_dispatch` を main 以外のブランチから起動すると `build` だけが走り、設定の不備や
ビルドの失敗をマージ前に検出できます（結果はジョブのサマリに出ます）。

`deploy` だけを Environment に載せているのは、main 以外からも走る `build` に配信の資格情報を
渡さないためです。`--branch=main` は「この成果物を本番とする」という指定なので、ref を
見ずに配信すると未マージのブランチの内容が本番を上書きします。

### 6. 注意

`VITE_` で渡した値はビルド時に文字列リテラルへ差し替えられてバンドルに焼き込まれ、
ブラウザから読めます。GitHub Secret にするのは履歴に残さず差し替えを効かせるためで、
**公開後の露出は防げません。** 予算アラートと1日あたりのクォータ上限を併せて掛けてください。

App Check のデバッグトークンだけは例外で、これは本物の秘密です。`deploy-web.yml` は
渡さず、読むのは開発ビルドの分岐の中だけに閉じています——分岐が畳まれても**値だけが
残る**ことが実際にあったためで（#395）、`apps/web/test/build/production-bundle.test.ts`
が実際にビルドして見張っています。

## 秘匿情報の取り扱い

| ファイル | 追跡 | 内容 |
|---|---|---|
| `apps/web/.env.example` | あり | テンプレート（プレースホルダのみ）|
| `apps/web/.env` | なし（gitignore）| 開発用の値と App Check デバッグトークン。コミット禁止 |

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
