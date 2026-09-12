# Flutter UI → React SPA 移植メモ（epic #382 Phase 3 / #386）

`packages/engine/PORTING.md` が Phase 1〜2（エンジン）の正本であるのに対し、ここは
Phase 3（アプリ側）の決定と対応表。

## このスライスの範囲

#386 は 7 画面・約 8,700 行の作り直しで、1 セッションに収まらない。最初のスライスとして
**土台とエンジンの配線まで**を入れた。画面はまだ無い。

- Vite + React + TypeScript の土台（`strict`）
- Phase 2 が意図的にエンジンへ置かなかった配線——fetch アダプタ・タイムアウト・App Check
  （`packages/engine/src/services/http-client.ts` と `route-service.ts` の冒頭がその宣言）
- `routeServiceProvider` 相当の組み立て
- ルーティングと画面状態のストア

## 決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| ルーティング | **React Router に一本化** | 現在地の権威を URL 一本にする。`AppState.screen` のミラーと、それに伴うエコー三重遮断が不要になる |
| 状態管理 | **Zustand**（単一ストア） | 複数フィールドを1回で書き換える形が `copyWith` の不変条件をそのまま表せる。React の外から読み書きでき、描画なしで状態テストが書ける |
| 置き場所 | **`apps/web/`** | `packages/engine` と対にする |
| npm workspaces | **置かない** | `functions/` が独自の package-lock と `firebase deploy` を持つ。hoisting で `functions/node_modules` が痩せるとデプロイが壊れる |
| エンジンの参照 | **ソース直参照**（alias + paths） | `packages/engine` を `noEmit` のまま使え、ビルド段が増えない |

### 戻り挙動（settings/search/result/error→home）

移植元は go_router の**ネスト構造そのもの**が Navigator の pop スタックだった。React Router の
ネストは `<Outlet>` の入れ子であって履歴を積まないので、URL の前置きだけでは戻り先にならない
（PR #391 レビュー）。`navigator.ts` で明示的に作っている。

- **home から子へは push、子から子へは replace、子から home へは pop。**
  履歴を常に高々 `[home, 子]` に保つ。子から home へ `replace` すると `[home, home]` になり、
  最初の「戻る」が home を再表示するだけでアプリを離れられない（実ブラウザで確認）。
  積んだ子を降ろす pop が移植元の Navigator.pop に対応する
- **ガードの跳ね返しは `redirect` ではなく `replace`。** `redirect` は跳ね返し先を積むので、
  弾かれた URL が履歴に残る。ガードが拒んだ location を履歴に残してはいけない
- **子を直接開いたときは、ルーターを作る前に生の History API で home を敷く。**
  ルーターは `RouterProvider` がマウントするまで履歴に繋がらず、それ以前の `navigate` は
  履歴に現れない（実ブラウザで確認）。マウント後に遷移で積む手もあるが、home を1フレーム
  描いてから子へ跳ぶちらつきが出る
- **敷いた履歴には、ルーターが自分で書くのと同じ深さ（`state.idx`）を書く。** 書かないと
  ルーターが現在のエントリへ 0 を振り、敷いた子が「手前が無い」と読まれる。子から子への
  遷移は replace で `idx` を保つので、その後ガードを要る画面へ移ってリロードすると、
  真下に home があるのに降りられない
- **リロードでガードを通らなくなった子からは、真下の home へ降りる。** 表示前提データは
  メモリ上のストアにしか無いので、アプリ内で開いた result / loading / error はリロードで
  通らなくなる。ガードに差し替えさせると真下の home と重なるため、`idx > 0` を確かめてから
  `history.back()` で降りる——降りるだけならエントリは増えない
- **ただしルーター由来のエントリでは敷き直さない。** アプリ内で home→子と遷移した後の
  リロードがこれにあたり、履歴は既に `[home, 子]`。敷き直すとリロードのたびに home が1つ
  増える（実ブラウザで `history.length` が 3→4 になるのを確認）。判定は `history.state` の
  有無——React Router は自分の作ったエントリに `{idx, key, usr}` を刻み、アドレスバー
  直打ちや外部からの deep link は null で入ってくる
- **起動直後のガードを通れない画面には敷かない。** `/home/result` のように表示前提データを
  要る画面を直接開くと、まだ経路を持たないストアではガードが home へ寄せる。先に
  `[home, result]` を積むとその下に余分な home が残る
- **積み直す URL はクエリ・ハッシュごと保つ。** 分類は `pathname` で行うが、`pathname` だけを
  push すると `?tab=a#section` が黙って消える（`screenFromLocation` はクエリ付きを明示的に扱う）

`PopScope(canPop: false)`（home・loading で戻るを無効化）は**再現しない**。あれは「戻るでアプリが
終了しない」というモバイルの要請で、web では戻ってサイトを離れるのが当然の挙動。ただし loading から
戻ったときに検索を止める必要はあり、それは検索のライフサイクルと対なので後続スライスで入れる。

### ルーティング一本化で失うもの

移植元は画面と表示前提データを同じ `copyWith` で書くため、両者は**構造的に**乖離し得なかった。
URL を権威にするとその保証は消え、「状態を書いてから遷移する」という規約になる。

そこで `go()` を唯一の入口にし、**navigate が呼ばれた時点でストアが遷移先のガードを通ること**
をテストで反証している（`test/state/store.test.ts`）。順序を入れ替えると赤くなる。
ガードは保証ではなく安全網である、という位置づけの違いに注意。

## テストの対応表

| 移植元（Dart） | 本数 | 移植先 |
| --- | ---: | --- |
| `test/core/services/timeout_http_client_test.dart` | 6 | `test/http/timeout-http-client.test.ts`（5）+ `test/http/app-check-http-client.test.ts`（1） |
| `test/core/services/app_check_http_client_test.dart` | 15 | `test/http/app-check-http-client.test.ts` |
| `lib/core/navigation/screen_paths.dart` | — | `test/navigation/screens.test.ts` |
| `lib/core/navigation/app_router.dart` の `redirect` | — | `test/navigation/guard.test.ts` + `test/navigation/router.test.ts` |
| `lib/core/state/app_state.dart`（経路検索の中核） | — | `test/state/store.test.ts` |

`packages/engine` の `check:port` のような名前照合はここには入れていない。あちらの基準値は
エンジンの 6 ファイルに固定されており、UI 側は「移植ではなく作り直す」（#386）ため
1 対 1 の対応そのものが存在しない。上の表が対応の記録。

### 移植元と意図的に変えた点

- **App Check のトークンプロバイダを必須にした。** Dart は `FirebaseAppCheck.instance` から
  静的に取れたが、Firebase JS SDK の `getToken` は `initializeAppCheck` が返すインスタンスを
  要る。相当する静的な入口が無く既定値を持てないので、Firebase の取得は合成のルートへ出した。
- **`'トークンが null …'` / `'… 空文字列 …'` の2本は標準プロバイダへ直接注入する形にした。**
  移植元は `limitedUseTokenProvider` を注入していたが、パスが consume 対象外
  （`googleWalkProxy`）なので実際に効いていたのは既定の標準プロバイダが Firebase 未初期化で
  投げる例外で、テスト名が言っていることとずれていた。
- **`'内側の App Check トークン取得がハングしても打ち切る'` は両プロバイダを遅くした。**
  片方だけだと、エンドポイントの分類（consume 対象か）を変える退行で巻き添えに赤くなる。

### まだ運んでいないもの

いずれも「対になる相手が来てから運ぶ」もので、移植漏れではない。

- `classifyRouteError`（`lib/core/models/route_error.dart`・テスト
  `test/core/models/route_error_test.dart`）— 文言と復帰導線と対で意味を持つ。エラー画面で運ぶ
- Firebase の初期化と App Check の有効化 — アプリ起動の配線。画面のスライスで入る
- 歩数・週間実績・HealthKit・ローカル通知・OS 設定 — Web で恒久的に落ちる機能として
  #386 が UI ごと作らないと決めたもの。**運ばないことが決定であって、保留ではない**
- 行程 handoff（`JourneyProgress`）— 上の歩数同期に依存する。結果画面のスライスで判断する
- loading から戻ったときの検索中断 — 上記のとおり検索のライフサイクルと対

### exactOptionalPropertyTypes は入れていない

`go()` が受ける `Partial<RouteCore>` には `{ route: undefined }` を渡せてしまい、
`X | null` を `=== null` で見ている箇所が「在る」と誤読する。型で塞ぐには
`exactOptionalPropertyTypes` だが、`apps/web` の tsconfig はエンジンのソースにも掛かる
（`paths` で直参照しているため）。`packages/engine` 側は有効にしていないので、
その設定下では通らないコードが 8 箇所出る。パッケージを跨いで厳しさを持ち込むことになるので
見送り、描画の可否を決める最後の関門（`guard.ts` と `isNowRouteExpired`）を `== null` で
受け止める形にした。エンジン側で有効化する判断は #385 の範囲。

### 既知の劣化

`go()` を遷移の決着前に続けて呼ぶと、2本目が現在地を古いまま読んで push してしまう
（`router.state.location` の更新が非同期のため）。home→loading→error が一気に起きる経路で
履歴が `[home, loading, error]` になりうるが、戻り先の loading は routePhase を失っており
ガードが home へ寄せるので安全側に倒れる。テストに事実として残してある。

**forward で無効になった子へ入ると home が1つ重複する。** 子から home へ pop した後、その子は
**前進側**の履歴に残る。表示前提データを失った状態（例: result の経路が #264 で失効）で
ブラウザの「進む」を押すと、ガードがその位置を home へ差し替えるので `[home, home]` になり、
次の「戻る」が home を再表示するだけになる（実ブラウザで確認。PR #391 レビュー）。

**直していないが、原理的に不可能なわけではない。** 一度は「History API はエントリを削除できない
から無理」と書いたが、これは誤り——`history.back()` は**エントリを増やさずに**真下へ降りるので、
差し替えの代わりに降りれば重複しない。実際、リロードで同じ形になる経路は [seedInitialHistory] が
その方法で解決している（`idx > 0` を確かめてから降りる）。

前進側だけ残しているのは、そちらの修正が**ガードの棄却パスの中**で起きるため。loader は
`replace` を投げるか値を返すかしかできず、降りる操作はルーター自身の遷移と競合する。
「降りてから null を返す」と前提データを欠いた子が一瞬描画され、「replace を投げてから降りる」と
2つの遷移が競合する。到達条件（pop 済み・前提失効・進む操作）に対して機構が重く、画面がまだ
無いので端から端まで検証できない。画面が入るスライスで扱う。代償は「戻る」1回ぶん。

## 設定

`.env` はコミットしない（`apps/web/.gitignore` が `.env*` を除外し、`.env.example` だけ通す）。
`dart_defines.json` / `dart_defines.example.json` と同じ作法。

```bash
cp apps/web/.env.example apps/web/.env
```

`VITE_` の値はバンドルへ焼かれブラウザから読める。秘匿値を置かないこと
（`docs/security_hardening.md`）。

## 動かす

```bash
npm --prefix apps/web ci
npm --prefix apps/web run typecheck  # 型（CI もこれを回す）
npm --prefix apps/web test           # CI もこれ
npm --prefix apps/web run build      # 本番バンドルの解決まで見る（CI もこれ）
npm --prefix apps/web run dev
```

Node は 22.22.0 以上が要る（`react-router` の要求）。`packages/engine` の `^22.12.0` より厳しい。
