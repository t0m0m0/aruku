# Flutter UI → React SPA 移植メモ（epic #382 Phase 3 / #386）

`packages/engine/PORTING.md` が Phase 1〜2（エンジン）の正本であるのに対し、ここは
Phase 3（アプリ側）の決定と対応表。

## スライスの範囲

#386 は 7 画面・約 8,700 行の作り直しで、1 セッションに収まらない。スライスに割っている。

**スライス1 — 土台とエンジンの配線**（PR #391）。画面は無く、ルートはプレースホルダ。

- Vite + React + TypeScript の土台（`strict`）
- Phase 2 が意図的にエンジンへ置かなかった配線——fetch アダプタ・タイムアウト・App Check
  （`packages/engine/src/services/http-client.ts` と `route-service.ts` の冒頭がその宣言）
- `routeServiceProvider` 相当の組み立て
- ルーティングと画面状態のストア

**スライス2 — home 画面**。デザイン基盤と最初の実画面。

- デザイントークン（`src/theme/`）・共有プリミティブ（`src/shared/`）・文言（`src/i18n/`）
- 現在地の取得（`src/location/`）
- home 画面（`src/features/home/`）。残り 6 画面はプレースホルダのまま
- 画面のテスト環境（jsdom + Testing Library）

**スライス3 — 検索画面**。home の地点の導線が着地する先と、その裏側。

- 地点検索（`src/places/`）——`placesProxy` 越しの autocomplete / details、検索履歴の
  永続化（localStorage）、候補から座標付きの地点への解決
- 検索の状態（`src/features/search/search-state.ts`）——待ち合わせ・世代ガード・
  「近くの店」の距離並べ替え
- search / searchOrigin 画面（`src/features/search/`）
- Firebase の初期化と App Check の有効化（`src/firebase/`）。placesProxy が
  consume 対象（#155）なので、これが無いと検索は全要求 401 になる

**スライス4 — 検索ライフサイクル**。移植したエンジンが実際に経路を返すところまで通す。

- 例外 → エラー種別の分類（`src/state/route-error.ts`）
- `startSearch` / `cancelSearch` / `abandonSearch`（`src/state/store.ts`）
- loading / error / result 画面（`src/features/`）。result は合計と区間一覧まで
- home の CTA を押せる状態へ戻す（スライス3 で塞いでいたもの）

**スライス5 — 日時ピッカー**。home で唯一まだ動かない操作を塞ぐ。

- `applyPickedTime` / `rebaseDates`（`src/state/store.ts`）
- 欄の値域（`src/features/picker/time-field-range.ts`）
- 時刻・日付の入力欄（`src/features/picker/time-field.tsx`）。home の表示だけの欄を置き換える

未着手: settings、result のタイムライン作り込みと区間 CTA、地図、
日本語フォントの同梱、Playwright。

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
| `lib/core/services/location_service.dart` | — | `test/location/geolocation.test.ts` |
| `lib/core/state/app_state.dart` の現在地まわり | — | `test/state/location.test.ts` |
| `lib/features/home/`（`testWidgets` は運ばない） | — | `test/features/home/home-screen.test.tsx` |
| `lib/shared/widgets/aruku_button.dart` / `icons/ic.dart` | — | `test/shared/button.test.tsx` + `test/shared/icons.test.tsx` |
| `test/core/services/places_service_test.dart` | — | `test/places/places-service.test.ts` |
| `test/core/services/recents_repository_test.dart` | — | `test/places/recents-repository.test.ts` |
| `test/core/models/recent_place_test.dart` | — | `test/places/recent-place.test.ts` |
| `test/features/search/place_selection_test.dart` | — | `test/places/resolve-prediction.test.ts` |
| `test/features/search/places_provider_test.dart` | — | `test/features/search/search-state.test.ts` |
| `lib/features/search/`（`testWidgets` は運ばない） | — | `test/features/search/search-screen.test.tsx` |
| `test/core/config/app_check_provider_test.dart` | — | `test/firebase/app-check.test.ts` |
| `test/core/models/route_error_test.dart` | — | `test/state/route-error.test.ts` |
| `lib/core/state/app_state.dart` の `startSearch` まわり | — | `test/state/search-lifecycle.test.ts` |
| `lib/features/loading/` / `error/` / `result/`（`testWidgets` は運ばない） | — | `test/features/loading/` / `error/` / `result/` |
| `test/core/state/app_state_time_revalidation_test.dart`（`applyPickedTime` まわり） | — | `test/state/picked-time.test.ts` |
| `test/features/picker/desktop_time_field_test.dart` | — | `test/features/picker/time-field.test.tsx` + `time-field-range.test.ts` |

`packages/engine` の `check:port` のような名前照合はここには入れていない。あちらの基準値は
エンジンの 6 ファイルに固定されており、UI 側は「移植ではなく作り直す」（#386）ため
1 対 1 の対応そのものが存在しない。上の表が対応の記録。

### home スライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 色の正本 | `lib/core/theme/aruku_colors.dart` | ハンドオフの `tokens.css` 以降に実装側だけが動いた（`ink3` が `#8A9583` → `#5F6E58`）。原本から引くと現行 Web 版と色が変わる |
| アイコンの正本 | `design_handoff_aruku_mvp/design-reference/icons.jsx` | Dart 版はこの SVG を Canvas 命令へ移したもの。戻り先はハンドオフのほう |
| `ArukuCard` | CSS のクラスへ落とす | 角丸・影・余白は使う側が直接書ける。Flutter に引数しか入口が無かった都合を運ばない |
| `ArukuButton` | 引数 12 個のうち 4 個だけ運ぶ | 同上。残りは `className` で足りる |
| i18n | 型付き定数モジュール | ロケールは ja のみ。react-i18next 等は実在しない要件のためにバンドルと間接参照を増やす |
| 読み上げ名 | `aria-label` で明示 | 中身から組ませると横並びか縦積みかで語の区切りが変わる。jsdom は CSS を読まないので、テストと実ブラウザで名前が食い違う |
| 現在地の初回取得 | ストア生成ではなく home の effect | `appStore` はモジュール読み込み時に作られる。そこで取ると読み込みだけで権限ダイアログが出る |

### 検索スライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 履歴の永続化 | `localStorage`（同期 API） | SharedPreferences が非同期だったために要った書き込みの直列化（`_writeLock`）が、同期なら丸ごと不要になる。`load→変更→save` の間に割り込む余地が無い |
| 検索状態の寿命 | 画面ごとに作って捨てる | 入力・候補・モードはこの画面の外に意味が無い。provider（アプリ寿命）に置くと、次に開いたとき前回の候補が一瞬見える |
| 履歴リポジトリの選択 | 画面が `mode` から選ぶ | 呼ぶ側に選ばせると mode と渡されたリポジトリが食い違っても型が通り、目的地の履歴に出発地が混ざる |
| 未配線の依存 | 描画した時点で落とす | 何も返さない `PlacesService` を既定に置くと、配線漏れが「候補が出ない検索画面」として残り、上流の不調と区別がつかない |
| 空のベース URL | 組み立てで拒む | 移植元は「候補なし」へ縮退させていた。設定漏れが正常な見た目で出てしまう。`createRouteService` と同じ判断で、検査は `src/http/base-url.ts` に1つ置いて共有する |

#### App Check を Vite で組む

- **デバッグトークンを書き込む分岐は `import.meta.env.DEV` を直に書く。** 移植元が release を
  バイパスの対象外にして作っていた「配布物には入り得ない」という保証（#297）を、Vite では
  定数畳み込みで作る。**引数や変数を1つでも経由させると畳めない**——`isDev` を既定引数に
  していたときは、書き込む行が本番バンドルに残っていた（`dist` を grep して確認）。実行時に
  到達しないだけの安全は、移植元が避けた形そのもの。そのぶん注入できず、この1点は
  `dist` の中身でしか反証できない。
- **サイトキーが無いとき（＝デバッグ時）は `CustomProvider` を渡す。** `ReCaptchaV3Provider('')`
  ではない——`initializeAppCheck` はデバッグモードでも `provider.initialize()` を必ず呼ぶため、
  reCAPTCHA の読み込みが `Missing required parameters: sitekey` で倒れる（実ブラウザで確認）。
  短絡するのはトークン**取得**だけで初期化はしない。移植元の `WebDebugProvider` に相当する器が
  JS SDK に無く、`initialize` が何もしない `CustomProvider` がその代わりになる。
- **有効化できないときはトークンの取れないプロバイダを返す。** プロキシは 401 を返す（＝安全側）。
  握り潰して素通しにはしない——課金 API が素通しで開くほうが、検索が失敗するよりはるかに悪い。
- **デバッグトークンは `appConfig` に置かない。** 分岐を畳んで消しても、`appConfig` は生きた
  export なのでプロパティに入れた**値だけが平文で残る**（esbuild はオブジェクトのプロパティを
  落とさない）。実トークンで本番ビルドしてバンドルから見つかった（PR #395 の Codex レビュー P1）。
  読むのは `if (import.meta.env.DEV)` の**中だけ**にして、値ごと分岐に閉じる。
  **分岐の除去と値の除去は別問題**という一点が、2度取り違えた理由。
- **この性質は単体テストから観測できない。** vitest は dev 条件で走るので畳み込みの結果が
  見えない。`test/build/production-bundle.test.ts` が実際に `vite build` を回して
  バンドルを検査する。空振りで緑にならないよう、「VITE_ の値が焼かれること」と
  「本番バンドルであること」を先に確かめてから不在を主張している
  （vitest の `NODE_ENV=test` が漏れて開発バンドルを検査していた事故を踏んだため）。

### 検索ライフサイクルのスライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 離脱で検索を止める合図 | ルーターの **POP** | アンマウントは StrictMode の二重マウントで偽物が混ざる。「loading から離れた」だけでも足りない（下記） |
| result の範囲 | 合計と区間一覧まで | #386 の完了条件は「経路検索が現行 Web 版と同じ結果を出す」。突き合わせに要るのは数字で、タイムラインの作り込みはそれを待たせる理由にならない |
| 未配線の `RouteService` | 呼ばれた時点で落とす | 黙って失敗する既定（例: 常に ZERO_RESULTS）だと、配線漏れが「ルートが見つからない」ともっともらしく出て上流の不調と区別がつかない |
| `classifyRouteError` の入力 | `ClientException` だけ見る | 移植元が `IOException` と両方見ていたのは dart2js の `dart:io` がスタブだから（#359）。こちらは `FetchHttpClient` が全て `ClientException` へ寄せる |
| 開いたままの経路の失効 | `visibilitychange` **＋締切タイマー** | 背面から戻ったときと、前面に置いたまま猶予を跨いだときの両方が要る。前者だけでは可視性が変わらない経路を塞げない |
| 現在地で失敗した再試行 | 測位し直してから引き直す | **移植元より進めた点。** あちらの再試行も `startSearch()` だけで、許可し直しても同じ null の出発地を送り続ける。主導線が永久に無意味になるため直した |

#### #264 の失効判定は 3 箇所で要る

1. 画面へ**入る**とき — ルートの loader（`guard.ts`）
2. 照会が**終わった**とき — `startSearch` の最後の砦
3. 開いたまま**居続けた**とき — `navigation/route-freshness.ts`（移植元 `onAppResumed`）

3 を落としていた（PR #398 の Codex レビュー P1）。結果を開いて放置した経路やタブを
背面にして戻ってきた経路が、猶予を超えても出たままになる——乗るはずだった便には
既に乗れない。1 と 2 はどちらも**画面を跨ぐときにしか走らない**ので、居続ける経路は
どちらにも掛からない。

さらに 3 は**合図が 2 つ要る**。最初は `visibilitychange` だけで塞いだつもりになって
いたが、前面に置いたまま見続けているときは可視性が変わらないので一生検算されない
（同レビューの追指摘）。猶予の締切にタイマーを張って両方を塞いでいる。

**離脱で検索を捨てるときは `routePhase` も落とす。** 残すと待ち画面の loader が
「前提は揃っている」と読んで通し、戻る→進むで**誰も完了させない待ち画面**へ入れる。

#### 検索が自分の遷移に殺される

待ち画面からの離脱で検索を止める仕組みは、**2 回作り直している**。どちらも実際に
本物の検索を殺してから分かった。

1. **アンマウントを合図にした** → StrictMode の mount→unmount→mount で、開いた直後に
   殺される。`main.tsx` が全体を StrictMode で包んでいるので開発ビルドでは必ず起きる。
   ルーターの購読（React の外）へ移した
2. **「現在地が loading でなくなったこと」を合図にした** → ルーターの購読は遷移の
   **途中**でも呼ばれ、そのとき location はまだ遷移前。`go(loading)` の最中に
   「loading から離れた」と読んで世代を進め、その検索自身の結果が stale として捨てられ、
   待ち画面から永久に動かなくなる。**実ブラウザで発覚**——購読の治具で location を
   原子的に変えていた単体テストは緑のままだった

現在は **POP（戻る／進む）だけ**を見る。移植元の `PopScope` が塞いでいたのは戻る操作
そのもので、アプリ側の遷移（push / replace）は検索の成否と対で起きるため止める理由が無い。
治具も「途中で 1 回・決着で 1 回」通知する形に直してある。

**反証できないガードは置かない。** 当初ストアに `searchInFlight` フラグも持たせていたが、
退行させてもどのテストも赤くならず、調べると守れている case が実在しないうえ、本当に
危ない interleaving では逆に効かないものだった。落とした。

### await を跨ぐ操作には `mounted` 相当のガードが要る

移植元の `if (!mounted) return;`（`search_screen.dart:62`）に相当するもの。画面で
`await` の後に状態や遷移を書くなら、`await` 直後に生存を確かめる。

```ts
const alive = useRef(true);
useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
// ...
const resolved = await something();
if (!alive.current) return;
```

**同じ穴を 2 回開けている。** 1 回目は検索画面の座標解決（移植漏れ・PR #395 レビュー）、
2 回目は失敗画面の再試行が測位を跨ぐところ（新規に書いたコード・PR #398 レビュー）。
どちらも「離脱後に届いた結果がストアを書き換え、`go()` で画面を引きずる」という同じ壊れ方。
picker / settings でも `await` を跨ぐ操作が出たら、**先にここを確認すること。**

**ただしアンマウントを「離脱」の合図にしてよいのはこの用途だけ。** 「離れたら止める」
という能動的な処理をアンマウントに紐づけると StrictMode の二重マウントで誤爆する
（上の「検索が自分の遷移に殺される」）。ここは続きを**書かない**ための受け身の確認なので、
偽のアンマウントで早期 return しても実害が無い。

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
- **geolocator の Web 向け回避策を運んでいない。** `location_service.dart` の
  `timeoutWholeRequest` は、geolocator_web が `timeLimit` をマイクロ秒として渡し 10 秒指定が
  約 2.8 時間になる件（#359）と、`checkPermission` が `'prompt'` を denied へ写す件への対処。
  W3C の API を直接呼ぶなら前提ごと無い。むしろ包むと、W3C の `timeout` が権限ダイアログの
  待ちを含まない規定である以上、ユーザーが考えている間に「取得できず」へ落ちる副作用だけが残る。
- **現在地の取得に「取得中なら相乗り」を足した。** 移植元に相当物は無い。React StrictMode が
  effect を二度走らせるため、素通しすると権限ダイアログが 2 回出る。
- **時刻フィールドは表示だけで押せない。** 日時ピッカーが未移植のため、押せる見た目にすると
  何も起きないボタンになる。ピッカーのスライスで押下を足す。
- **現在地は `RouteCore` に入れず `AppAmbient` に置いた。** ガードの判定材料ではない。
  `RouteCore` に混ぜると `go()` の update で書けてしまい、「画面と一緒に書き換えるもの」という
  `RouteCore` の意味が薄れる。
- **履歴の打刻はリポジトリが行う。** 移植元も `add` で打っていたが、`resolvePlacePrediction` は
  「確定した地点」を返すだけで、それが履歴に入る時刻を知らない。解決側で打つと、確定した時刻と
  記録した時刻という2つの意味が1つの項目に混ざる。
- **壊れた `usedAt` を落とす。** Dart の `DateTime.parse` は投げるので上位の捕捉に入るが、
  `new Date` は静かに Invalid Date を返し、書き戻す `toISOString()` が後から RangeError になる
  ——壊れた1件が履歴の保存全体を、原因から遠い場所で落とす。
- **`dispose()` が世代を進める。** 移植元は provider の寿命に任せていた。debounce を落とすだけ
  では、すでに走り出した取得が解決して閉じた画面の状態へ書き戻る。

### まだ運んでいないもの

いずれも「対になる相手が来てから運ぶ」もので、移植漏れではない。

- 履歴のクラウド同期（`RecentsRepository.replaceAll`）— 同期の相手（認証と Firestore）が
  まだ無く、運んでも呼ぶ側が存在しない
- 歩数・週間実績・HealthKit・ローカル通知・OS 設定 — Web で恒久的に落ちる機能として
  #386 が UI ごと作らないと決めたもの。**運ばないことが決定であって、保留ではない**
- 行程 handoff（`JourneyProgress`）— 上の歩数同期に依存する。結果画面のスライスで判断する
- 結果画面のタイムライン作り込み（`result_timeline.dart`）と区間 CTA（`result_leg_cta.dart`）
  — 前者は表示の作り込み、後者は行程（`JourneyProgress`）＝歩数同期に依存する。
  区間そのものは一覧で出している
- 経路の共有（`resultShareText`）— 外部連携で、経路検索の正しさとは独立
- 日本語フォントの同梱 — 初回ロード gzip 500KB 未満（#386 の完了条件）との兼ね合いを実測して
  から決める。`--font-jp` 1 行の差し替えで済む形にしてある
- デスクトップ幅の作り分け（#372 の `DesktopContent` / `DesktopTimeField` /
  `DesktopTypeaheadField`）— 以前ここには「検索のスライスで対に入れる」と書いていたが、
  スライス3 では入れていない。`DesktopTypeaheadField` だけ先に入れても、同じ画面の
  時刻フィールドがまだ押せない以上ホームは片肺のまま——3 つは #372 の 1 つの作り分け
  であって、Places の移植が済んだかどうかで割れる単位ではなかった

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

### 日時ピッカーのスライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| ピッカーの実体 | native の `<input type="time">` / `<input type="date">` | 移植元の2実装（モバイルのホイールシート・デスクトップの自作カレンダー）は、ブラウザが端末に合わせて出すものの再実装。出し分けごと要らなくなる |
| 入力文字列の解釈（`parseTimeInput`） | 運ばない | 任意の文字列が来ない。確定した値は必ず `HH:MM` で、打ちかけは空文字 |
| 確定の契機 | **blur**（と Enter） | time 入力は打鍵ごとに change を上げる（下記）。移植元が「焦点が外れて初めて確定する」と書いていたのと同じ理由 |
| ↑↓ の刻み | 横取りして自前で持つ | native の刻みは同日内で折り返す。日をまたぐ刻みで日付を据え置くと予算が 25 時間近くへ膨らむ |
| 値域の保証 | `applyPickedTime` 側 | `min` / `max` は案内であって保証ではない。キー入力もオートフィルも範囲外を渡せる |
| 基準日 | **ストアが持つ**（`RouteCore.dateBasis`） | 描画のたびに読み直すと打鍵の再描画で基準だけが進む。欄ごとの ref でも足りない（下記） |
| `rebaseDates(0)` の素通し | **常に通す**（移植元と同じ） | 「今すぐ」の出発は保持している h/m が古びる。跨いだときだけ詰めると、同じ日のうちは古い出発と比べ続ける（下記） |
| 確定に渡す日付 | 時刻は**相対**・日付欄だけ**絶対** | 時刻の欄が指定したのは時刻だけ。絶対日付で持ち回ると、跨いだ直後の確定が「もう過ぎた日」を指す |
| 保持中の経路 | 時刻が動いたら捨てる | web には「進む」がある。降りた result が前方に残り、ガードは `route` が在れば通す |

#### time 入力は打鍵ごとに change を上げる

既に値のある欄へ `2358` と打つと、実ブラウザ（Chrome）は `02:00` → `23:00` →
`23:05` → `23:58` と**4回**の change を上げる。セグメントが空にならないので、途中の
値もすべて「完全な時刻」として来る。

change で確定すると、最初の `02:00` に過去時刻の切り上げが割り込み、打った値ごと
現在時刻へ差し替わる。**jsdom では見えない**——テストは change を1回しか起こさない
ので、確定の契機を change に置いても緑のまま通る。実ブラウザで観測して初めて分かる。

#### 基準日は、それが数えている出発・到着と同じ場所に置く

`dateOffset` は「今日からの日数」だが、その基準日は保持していると黙って古びる。開いた
まま日を跨ぐと保持値は1日先を指すので、確定の前に跨いだぶんを詰め直す。

その差の測り方を 2 回間違えた。

1. **描画のたびに `now()` を読む**と 0 になる。打鍵で再描画された時点で基準だけが
   新しい日へ進み、状態は古い日に取り残されるため。詰め直しが走らず、触っていない側
   （出発を打っているときの到着）が1日先を指したまま残る。
2. **欄ごとに ref で留める**と、片方だけが進む。home は出発と到着の 2 つを出すので、
   出発を確定して詰め直しても到着の欄の基準は昨日のまま——その欄は詰め直し済みの
   offset を昨日基準で描き、確定すると**同じ1日をもう一度**適用する
   （PR #399 の Codex レビュー）。

基準は offset と同じ状態（`RouteCore.dateBasis`）に置き、`rebaseDates` が両者を同じ
更新で動かす。画面と表示前提データを同一更新で書くのと同じ理由で、別々に書けば
間に挟まる描画が新しい基準で古い offset を読む。

#### 「今すぐ」の出発は、日を跨がなくても古びる

跨いだときだけ詰め直す実装にしていたが、それだと同じ日のうちに古い出発と比べ続ける。
09:00 に開いて正午に到着 13:00 を選ぶと、比較の相手は 09:00 のままなので予算 4 時間
として記録される。`startSearch` は出発だけを正午へ更新して予算を保つので、**選んだ
13:00 ではなく 16:00 着を探しに行く**（PR #399 の Codex レビュー）。

移植元が 0 でも素通しにしなかったのは、これが理由。日付ダイアログという区切りが
あったからではない。

#### 日跨ぎの表示は、開いたまま放置しても直らない

基準を ref に留めた結果、日が変わっても欄の日付は勝手に書き変わらない（触った時点で
揃う）。移植元も同じで、あちらの日付ラベルも `onAppResumed` や再描画が来るまで古い
ままだった。**意図して揃えていない**——直すには真夜中に起きるタイマーが要り、それは
経路の失効（`navigation/route-freshness.ts`）と同じ仕掛けを別の目的で足すことになる。

## 動かす

```bash
npm --prefix apps/web ci
npm --prefix apps/web run typecheck  # 型（CI もこれを回す）
npm --prefix apps/web test           # CI もこれ
npm --prefix apps/web run build      # 本番バンドルの解決まで見る（CI もこれ）
npm --prefix apps/web run dev
```

Node は 22.22.0 以上が要る（`react-router` の要求）。`packages/engine` の `^22.12.0` より厳しい。
