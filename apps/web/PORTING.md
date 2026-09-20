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

**スライス6 — settings 画面**。7 画面目で、ルート表からプレースホルダが消える。

- settings 画面（`src/features/settings/`）。規約・プライバシーポリシーへのリンクと、
  権限をどこで変えるかの案内だけ
- 法的情報の URL（`src/config.ts`）

**スライス7 — result のタイムライン**。最後の画面の作り込み。

- タイムライン（`src/features/result/result-timeline.tsx`）——ノード行・直結乗換の
  コネクタ・区間カード。結果画面のフラットな区間一覧を置き換える
- 歩行・電車アイコン（`src/shared/icons.tsx`）と区間の文言（`src/i18n/ja.ts`）

**スライス8 — 地図**。7 画面が揃った後の、画面をまたぐ最後の部品。

- 経路 → 図形の対応づけ（`src/map/route-overlays.ts`）——区間ごとの線・始終点・矩形
- 作り物の地図（`src/map/stylized-map.tsx`）と地図の配色（`src/theme/tokens.css` の
  `--map-*`）。キー未設定時の描画で、loading の背景もこれ
- 実地図（`src/map/aruku-map.tsx`・`src/map/map-style.ts`）——`@vis.gl/react-google-maps`
  越しの `<Map>`、polyline・始終点の印・経路全体へのカメラ合わせ
- `VITE_MAPS_WEB_API_KEY`（`src/config.ts`）
- result のプレビューと loading の背景（`src/features/result/`・`src/features/loading/`）

**スライス9 — 日本語フォントの同梱**。移植元の `GoogleFonts.notoSansJp` のランタイム取得を、
#382 の方針どおり同梱へ置き換える。

- 語彙の収集と絞り込み（`vite/font-subset.ts`）——描画される文言から語彙を作り、
  Fontsource の分割をその積へ絞る Vite プラグイン
- フォントスタック（`src/theme/tokens.css` の `--font-jp`）を二段構えへ
- `@fontsource-variable/noto-sans-jp`（遅延段）と `subset-font`（ビルド時の絞り込み）

**スライス10 — E2E（Playwright）**。移植で一度も自動にできなかった確認を自動にする。
Flutter web では不可能だった（`visibilityState=hidden` で rAF が止まる・#382）ものが、
DOM ベースの SPA にした見返りとしてここで手に入る。

- 偽の上流（`e2e/upstream/`）——Transit API とプロキシの応答を要求から組み立てる
- 主導線（`e2e/route-search.spec.ts`）と履歴の積み方（`e2e/navigation.spec.ts`）
- `playwright.config.ts`・CI の `e2e` ジョブ

これで #386 の「やること」の項目は埋まった。

区間 CTA は**運ばない側**へ移した。以前ここには未着手として並べていたが、`JourneyProgress`
＝歩数同期に依存し、それは #386 が Web で作らないと決めたもの——下の「まだ運んでいないもの」
と食い違っていた。

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
| `lib/features/result/result_timeline.dart` | — | `test/features/result/result-timeline.test.tsx` |
| `test/core/state/app_state_time_revalidation_test.dart`（`applyPickedTime` まわり） | — | `test/state/picked-time.test.ts` |
| `test/features/picker/desktop_time_field_test.dart` | — | `test/features/picker/time-field.test.tsx` + `time-field-range.test.ts` |
| `lib/features/settings/`（`testWidgets` は運ばない） | — | `test/features/settings/settings-screen.test.tsx` |

`packages/engine` の `check:port` のような名前照合はここには入れていない。あちらの基準値は
エンジンの 6 ファイルに固定されており、UI 側は「移植ではなく作り直す」（#386）ため
1 対 1 の対応そのものが存在しない。上の表が対応の記録。

`e2e/` はこの表に載らない。移植元に相当物が無い——Flutter web はエージェント／
ヘッドレスから操作できず（`visibilityState=hidden` で rAF が止まる・#382）、E2E そのものが
存在しなかった。

### フォント同梱の決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 書体 | Noto Sans JP（可変） | 移植元の `GoogleFonts.notoSansJp` と同じ。使う側は 500/600/700/800 の4段を引くが、可変1本で賄えるので重みごとにファイルを持たない |
| 同梱の形 | **二段構え**——語彙段を先、Fontsource を後 | Fontsource の 124 分割だけでは完了条件を割る。下の実測を参照 |
| 語彙の出どころ | コメントを剥いだ全 `.ts(x)` の文字列リテラルと `index.html`、**および `packages/engine/src`** | `i18n/ja.ts` だけでは足りない。`format.ts` の「月」「日」、`loading-screen.tsx` の「まで · 制限」、エンジンの `TimeValue.dateLabel()` の「明日」と `rail-line-names.ts` の路線名が抜ける。エンジンは alias でソース直参照され同じバンドルへ入るので、その文字列リテラルは apps/web 自身のものと同じだけ描かれる |
| 絞り込みの置き場所 | **Vite プラグイン** | CI は `npm run build` ではなく `npx vite build` を直に叩く。prebuild の script に置くと CI で黙って飛び、フォントの無い dist が「成功」として出る |
| 分割の割り当て | 各 face の unicode-range と語彙の**積** | 文字ごとに1つへ割り振ると、CSS の後勝ちで当たる face とずれ、当たった側にグリフが無くなり得る |
| 語彙段の配り方 | 25 ファイルのまま `unicode-range` 付きで置く | 1本へ畳む（base64 等）と全部が先読みになる。分けたままなら、その画面が実際に描く塊しか取られない |

#### なぜ Fontsource をそのまま先頭に置けないか

あの 124 分割は日本語の「文章」向けで、散らばった UI 文言には噛み合わない。実測:

| | サイズ |
| --- | ---: |
| JS | 160.9 KB (gzip) |
| CSS（両段の @font-face 宣言込み） | 40.8 KB (gzip) |
| Fontsource をそのまま引いた場合のフォント | 839 KB |
| 語彙ぶんへ絞った場合のフォント（38 ファイル） | 179 KB |

そのままだと合計が #386 の完了条件（初回ロード gzip 500 KB 未満）を割る。内訳が噛み合わなさを
示していて、「遅」1文字のために 18.8 KB、「候」1文字のために 17.7 KB を取る。絞れば同じ1文字が
1.5 KB になる。

#### 描かれる空白を語彙から落とさない

空白（U+0020）を「グリフが要らない文字」として落とすと、語彙段がそれを覆わなくなり、
ブラウザは空白を描くためのフォントを**次の family へ探しに行く**——遅延段の latin と 117 を
引いて、空白1文字のために 92 KB を落としていた。落としてよいのは改行・タブ・制御文字だけ。

同じ形で `index.html` の `<meta name="description">` も抜けていた。タグを丸ごと落とす実装だと
content 属性ごと消え、この app で index.html にある日本語はそこにしか無い。

**どちらも豆腐にならない。** 遅延段が拾って正しく描いてしまうので、画面を見ても分からず、
出るのは初回ロードの重さとしてだけ。最初に書いた調査用の probe は走査から空白を除いており、
探している当のものを自分で隠していた（#402 と同じ形）。反証は network の実測に置いている。

#### 残っている観測: 遅延段が1ファイルだけ先走って取られる

本番ビルドでも `noto-sans-jp-117`（80 KB）が1つだけ取得される。原因は特定できていないが、
**語彙の不足ではない**ことは確かめてある——この face の unicode-range に含まれる全
コードポイントについて `document.fonts.check()` が語彙段で真を返し、文書中に語彙段が
覆わない文字は無い。`font-display: swap` の最中に Chrome が次の family を先回りして
解決しているものと見ている（温かいキャッシュでは 300 B の再検証に縮む）。

完了条件は満たしたまま（最悪でも 381 KB + 80 KB = 461 KB < 500 KB）なので、このスライスでは
塞いでいない。塞ぐなら遅延段の unicode-range から語彙を引いておく形になる。

### E2E のスライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 走らせる相手 | **本番ビルドの成果物**（`vite build` → `vite preview`） | 開発サーバだと `import.meta.env.DEV` が真で App Check がデバッグプロバイダごと有効化され、起動のたびに Firebase へ実通信する。ビルドは実測 1.2 秒で、毎回作り直しても足を引かない |
| 上流 | 偽物を**同一オリジン**に据える | 別オリジンだと CORS と preflight の話が混ざる。確かめたいのはアプリの配線であってブラウザの CORS ではない |
| 偽の応答 | 要求から**その場で組み立てる** | 録画（URL ごとの当てはめ）だと、乗車駅探索の引き直しやコリドーへの徒歩マトリクスのように探索で URL が変わる要求に当たらなくなる。当たらなかった要求は上流の不調と同じ顔（候補ドロップ・直線推定）で静かに縮退する |
| 距離と所要 | **エンジン自身の定数**で組む（`haversineKm` / `walkMetersPerMinute` / `trainMetersPerMinute`） | `packages/engine` のテストと同じ形。偽の上流が実在の街路より速い・遅いことを主張してしまわない |
| 目的地の距離 | 現在地から約 7.4km | 全徒歩なら初期予算（60 分）を超え、電車1本で収まる。主導線が偽の上流の作りではなく**距離**で選ばれる。近すぎると経路が全徒歩へ畳まれ、電車区間の描画を一度も通らない |
| 再試行 | **しない**（`retries: 0`） | E2E の再試行は、実際に壊れている競合を「たまに赤い」だけの見た目へ薄める |
| プレビューの使い回し | しない（`reuseExistingServer: false`） | 使い回すと直前の編集を含まない古い成果物に対して緑になる |

#### 番人が見ているのは「画面に出ない失敗」

`e2e/fixtures.ts` が全 spec に自動で付ける。どれも**画面を見ても分からない**種類の退行で、
移植中に実際に踏んだものと対応する。

- **コンソールの error / 未捕捉の例外** — 縮退の catch に握り潰された失敗は画面に出ない
- **外部オリジンへの要求** — 上流が偽物ではなく本物へ漏れると App Check 無しで 401 になり、
  画面には「通信に失敗しました」としか出ない。同じ網がフォント同梱（スライス9）の退行も
  捕らえる——ランタイム取得へ戻れば `fonts.gstatic.com` がここに並ぶ
- **どのハンドラにも当たらなかった上流要求** — 偽の上流の取りこぼし。黙って本物の
  プレビューへ通すと `index.html` が JSON として読まれ、「上流のスキーマが壊れた」
  ようにしか見えない

#### 偽の上流が**答えない**もの

- **到着アンカー（`type=arrival`・#376）には空の options を返す。** 出発の絶対時刻を
  知らないまま到着から逆算すると、発車済みの便を「乗れる」と名乗る option ができる
  ——`arrivalMinutes` は壊れた時刻を必ず速い方向へ縮退させるので、偽の上流が嘘をつくと
  画面はそれを速い経路として出す。第2波は fail-soft なので、空でも departure 波だけで
  続行する。**第2波が経路の中身に効くことは、この spec では確かめていない**
- **App Check のヘッダ。** サイトキーを空にして無効化している（本物へ出さないため）。
  ヘッダが付く経路は `test/http/app-check-http-client.test.ts` が持つ
- **実街路が直線より長い条件。** 徒歩プロキシは直線距離をそのまま返す。伸ばすと
  「選定時は予算内だった候補が実測で超過へ転じる」経路（#254）に入り、主導線の spec が
  予算超過の画面を出すかどうかで揺れる。その振る舞いを主題にする spec が自分で用意する

#### 完了条件①（現行 Web 版と同じ結果）について、E2E が言えること

「経路検索が現行 Web 版と同じ結果を出す」を E2E が丸ごと保証するわけではない。分けて書く。

| 層 | 何が根拠か |
| --- | --- |
| エンジンの選定ロジック | Dart 版のテストを移植した `packages/engine` の suite（#384・`check:port` が移植漏れを見る） |
| 上流へ渡す照会の中身 | `e2e/route-search.spec.ts` が座標・日付・`numItineraries`・`avoidModes` を固定する |
| 画面への出方 | 同 spec と `test/features/` |
| **実データでの突き合わせ** | 実施済み（下の「実データでの突き合わせ」）。本物の Transit API とプロキシの応答を録り、Dart 版と TypeScript 版へ同じものを流して結果を比べた |

### 実データでの突き合わせ

完了条件①「経路検索が現行 Web 版と同じ結果を出す」の根拠。**両エンジンへ同じ実データを
流して結果を突き合わせた**もので、E2E の偽の上流に対する一致とは別の層にある。

やり方は録画と再生に分ける。本物へ2回投げて比べる形は採れない——時刻表も徒歩の実測も
照会のたびに動くので、差が出たとき移植の差なのか上流の差なのか判別できない。

1. **録画** — `apps/web` の実配線（`createTransitClient` / `createProxyClient`。App Check
   込み）で本物の上流へ1回投げ、全往復を URL→本文で保存する
2. **再生（TS）** — 録画を `TransitRouteService` へ流し、**録画時の生の結果と一致すること**を
   確かめる。ここが録画の完全性の検査で、通らない限り Dart との差は読めない
3. **再生（Dart）** — 同じ録画を Dart 版の `TransitRouteService` へ `MockClient` 経由で流す
4. **比較** — 合計・区間・絶対時刻・polyline 先頭・タイムラインを同じ形へ落として比べる

| ケース | 上流往復 | 結果 | 一致 |
| --- | ---: | --- | :-: |
| 新宿→東京（6.1km・90分） | 26 | 88分 / 徒歩 5.05km / 49.6% / 徒歩3分＋大江戸線11分＋徒歩70分 | ✓ |
| 新宿→大宮（25km・180分） | 11 | 171分 / 徒歩 9.11km / 30.1% / 徒歩124分＋湘南新宿ライン31分＋徒歩3分 | ✓ |
| 新宿→高田馬場（2.6km・60分） | 28 | 41分 / 徒歩 3.00km / 100% / 全徒歩 | ✓ |

丸め（小数6桁）まで含めて完全一致した。

#### 締切と1本あたりの上限は、突き合わせから外す

どちらも**壁時計に依存する**ので、残すと結果が上流の速さの関数になる。同じ入力でも
録画時と再生時で探索量が変わり、測っているものが「移植の一致」でなくなる。

- `SearchDeadline`（#300）は改善ラウンドを打ち切る。録画・再生とも `none()` にした
- `TimeoutHttpClient`（#156）は**超過しても内側を止めない**（中断は `close()` の仕事・#259）。
  fetch の層で録ると、エンジンが TIMEOUT として捨てた応答が遅れて 200 で録画に残り、
  再生はそれを読めてしまう。guidance の実測が ~20s で上限が 35s なので普通に起きる。
  録画時だけ上限を 120s へ上げて回避した

どちらの振る舞いも #384 の移植済み suite が持っているので、ここで重ねて見る必要はない。

#### 縮退は隠さずに録る

高田馬場のケースは、乗車駅探索の `from≈to` の短い probe に上流が**決定的に** 503 を返す
（4回とも同じ）。これを「上流が 200 以外を返したら録り直す」で弾くと、**たまたま
乗車駅探索へ入らなかった回だけが録画として残る**——再生はそこから探索へ入るので、
録画に無い要求を引いて食い違う。実際にそれで1度詰まった。

503 ごと録れば再生が決定的になり、**両エンジンが同じ縮退をするか**も突き合わせの対象に
なる。一過性の 5xx（#361）とは区別が要る：そちらは録り直す。

#### 残った差: Dart が1本多く発行する

高田馬場のケースで、Dart 版は乗車駅探索の probe 経路で TS 版が出さない `/guidance/plan`
を1本多く発行する。3回走らせて常に1本なので、スケジューリングのゆらぎではなく決定的な差。

**結果には効かない**——上の表のとおり3ケースとも完全一致している。機序は特定していない。
`Promise.all` と `Future.wait` の失敗時の振る舞いの違いが候補だが、確かめていない。

#### 治具を残していない

再生の Dart 側は `lib/` のエンジンに依存し、#387 が消す側にある。残すと撤去のときに
道連れで消すか、消し忘れて腐るかのどちらかになる。上の手順が再現に要る情報。

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
- 区間 CTA（`result_leg_cta.dart`）— 行程（`JourneyProgress`）＝歩数同期に依存する。
  タイムライン本体はスライス7 で運んだ。**保留ではなく、運ばない側**——依存の先が
  「作らない」と決まっている以上、対になる相手は来ない
- 経路の共有（`resultShareText`）— 外部連携で、経路検索の正しさとは独立
- 日本語フォントの同梱 — 初回ロード gzip 500KB 未満（#386 の完了条件）との兼ね合いを実測して
  から決める。`--font-jp` 1 行の差し替えで済む形にしてある。地図を入れた時点で 160.7KB
  （gzip）なので、残りは約 340KB
- `ArukuMap` の variant（`nav` / `thumb`）— 移植元でもどこからも指定されておらず、全 3 箇所が
  既定の `full`。寄り視点を使う nav 画面は Web に無い
- デスクトップ幅の作り分け（#372 の `DesktopContent` / `DesktopTimeField` / <!-- doc-consistency:keep: 移植元（Dart）の widget 名。lib/shared/widgets/desktop_content.dart は健在 -->
  `DesktopTypeaheadField`）— 以前ここには「検索のスライスで対に入れる」と書いていたが、
  スライス3 では入れていない。`DesktopTypeaheadField` だけ先に入れても、同じ画面の
  時刻フィールドがまだ押せない以上ホームは片肺のまま——3 つは #372 の 1 つの作り分け
  であって、Places の移植が済んだかどうかで割れる単位ではなかった。**#386 の外に出して
  #406 で運んでいる**（下の「デスクトップ幅の作り分け」）

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

### 設定スライスの決定

移植元（`lib/features/settings/`、483 行）の5セクションのうち4つは、#386 が「Web で
落ちる機能の UI を作らない」と決めた機能の設定だった。**この画面には永続化する設定が
1つも無い**——`AppSettings` の3フィールドがすべて非対応機能のものなので、
`SettingsRepository`・lost update を防ぐ書き込みの直列化（`_queue`）・保存失敗の
SnackBar という移植元の複雑さの中心が、まるごと移植対象から外れる。

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 通知・週間目標・ヘルスケア連携 | セクションごと作らない | Web で恒久的に落ちる機能。非対応の理由を出す注記も、機能を作らない以上は書く相手がいない |
| 権限の案内 | **1行だけ残す** | 位置情報は Web でも実在し、拒否されると出発地と経路検索が詰む。非対応機能の言い訳ではなく、対応している機能の操作方法。ただし移植元の「位置情報・通知の権限」から通知を落とした |
| OS 設定を開く導線 | 作らない | 開く先が無い。押しても無反応の導線を残すと、権限を変えられない理由が画面から復元できない |
| 外部リンク | 素の `<a target="_blank" rel="noopener noreferrer">` | `url_launcher` と「開けませんでした」の通知は運ばない。ブラウザではリンクを開くことが失敗し得る操作ではなく、`launcher` が false を返すという概念が無い。`rel` は暗黙の noopener に任せず明示する |
| 規約・プライバシーの URL | `src/config.ts` に定数（移植元と同じプレースホルダのまま） | デプロイごとに変わらない固定のリンク先。env にすると設定漏れが「規約が開かない」という遠い失敗になる。実 URL への差し替えは #386 の範囲外 |
| `ScreenPlaceholder` と `default` 節 | 撤去する | 残すと次に画面が増えたときに黙ってそこへ落ちる。網羅していなければ `tsc` が TS2366 で落とす（`case` を1つ外して確認） |

セクションの一覧はテストで**完全一致**に固定した。「通知スイッチが無いこと」のような
不在のアサーションは、実装していない間ずっと緑のままで何も検証しない。

### 日時ピッカーのスライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| ピッカーの実体 | native の `<input type="time">` / `<input type="date">` | 移植元の2実装（モバイルのホイールシート・デスクトップの自作カレンダー）は、ブラウザが端末に合わせて出すものの再実装。出し分けごと要らなくなる |
| 入力文字列の解釈（`parseTimeInput`） | 運ばない | 任意の文字列が来ない。確定した値は必ず `HH:MM` で、打ちかけは空文字 |
| 確定の契機 | **欄の外へ出たとき**（と Enter） | time 入力は打鍵ごとに change を上げる（下記）。移植元が「焦点が外れて初めて確定する」と書いていたのと同じ理由 |
| 確定の単位 | 時刻と日付で**1つの下書き** | 片方ずつ確定すると、並び順どおりに触っただけで値が消える（下記） |
| 触られたかの判定 | 値の比較ではなく**編集の有無** | 同じ値を打ち直したのか通り抜けただけなのかが、値からは区別できない |
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

#### 時刻と日付は、片方ずつ確定してはいけない

欄は時刻と日付の2つに分かれているが、指定は対で意味を持つ。正午に「明日 09:00 発」と
決めようとして**並んでいる順に**——時刻を打ってから日付を選ぶ——触ると、日付欄へ移る
blur が時刻だけを確定する。09:00 は今日の過去時刻なので現在時刻へ切り上げられ、続く
日付の確定はその切り上げ後の値を読む。**打った 09:00 は消え、明日 12:00 発になる**
（PR #399 の Codex レビュー）。

同じ欄の中の移動（時刻↔日付）では確定せず、欄の外へ出たときに時刻と日付をまとめて
確定する。判定は `relatedTarget` が欄の中かどうか。

触られていない側は、下書きではなく**詰め直し後の状態**から採る。欄が出しているだけの
値は保持値の描画であって指定ではないので、そのまま確定に使うと、詰め直しが引き上げた
時刻や日付を古い表示で上書きしてしまう。「触られたか」を値の比較で代用しないのも同じ
理由——同じ値を打ち直したのか通り抜けただけなのかは、値からは区別できない。

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

#### `dateOffset` を絶対日付へ直すのは、この状態の**外**にいる

基準を `dateBasis` として持ったが、それを見て日付を決めている相手は 1 つも無い。
実際に日を決めるのは**照会側**（エンジンの `TransitRouteService.departureDateTime`）と
**欄**で、どちらも自分の時計の「今日」から数える。エンジンは Phase 1〜2 の移植契約が
あるので、基準を渡す形には変えていない。

つまり「保持値は常に今日基準である」は、状態の側が**出入り口で維持する不変条件**に
なる。維持し損ねたのが、開いたまま日を跨いでからの検索だった——どちらの欄も触らずに
検索すると詰め直しが走らず、明日 10:00 発の予定が明後日として照会される
（PR #399 の Codex レビュー）。`startSearch` と `expireRoute` の先頭で揃える。

出発・到着を書く更新は `dateBasis` も一緒に書く。逆に、**offset を動かさずに基準だけ**
進めてはいけない——固定の予定が黙って1日先を指す。

**日付を出す側も同じ**。result のヘッダーは描画時刻から数えていた。固定出発の経路は
`routeAsOf` を持たない＝失効しないので日を跨いでも開いたまま残り、旅程は変わっていない
のに日付だけ1日進む（PR #399 の Codex レビュー）。`dateOffset` を絶対日付へ直す箇所は
`dateBasis` を基準にする——この画面はそのために現在時刻の注入口ごと落とした。

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

### タイムラインのスライスの決定

**journey 進捗は運ばない。** 移植元の `_LegState`（done / current / upcoming）と
`_LegStateBadge` は `JourneyProgress` を読む（#305）。それは歩数同期に依存し、#386 が
UI ごと作らないと決めた側。移植元で言えば `journey == null` の `_LegState.none` だけが
残った形になる。**運ばないことが決定であって、保留ではない。**

**図案の戻り先は Dart ではなくハンドオフ。** `result_timeline.dart` は
`CustomPaint` と `_SegLinePainter` で線を引いているが、原本は
`design_handoff_aruku_mvp/design-reference/screens-result.jsx` の CSS（徒歩は
`3px dotted`、乗り物は `3px solid`）。Dart 版がそれを Canvas へ移したもので、そこから
起こし直すと二重の写しになる（`src/shared/icons.tsx` 冒頭と同じ理由）。

**行は 1 つのグリッドに乗せる。** 移植元は各行が `[44px 時刻][14 隙間][16 トラック][残り]`
の `Row` で、幅指定を行ごとに繰り返していた。同じことを CSS でやると、片方だけ直したときに
トラックの縦線が折れる。`li` を 3 列のグリッドにして列を共有させている——ノード行と
レッグ行が同じ `li` の中にあるのはそのため。

**徒歩の km/kcal が欠けても描く。** 移植元は `seg.km!` で、null なら落ちた。TypeScript 側の
型は `number | null` を明示している。経路生成は徒歩レッグに必ず埋めるが、描画で落とす価値は
無いので、欠けている側だけ出さない（区切りの中黒も一緒に落ちる）。

**所要時間はテストから 1 本の文字列として見えない。** 数字と単位で書体・字送りが違うため
別のスパンに割れており、`getByText` は要素の直下テキストしか見ない。読み手に届く形は
連結後なので、行の `textContent` で見ている。この見方は「割った断片が隙間も入れ替わりも
無く並ぶ」ことまで押さえる。

### 地図のスライスの決定

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| ライブラリ | `@vis.gl/react-google-maps` | `google_maps_flutter_web` の `window.google.maps` ロード待ちハックが要らなくなる（#386 の想定どおり）。Maps JS API 自体はランタイム取得なのでバンドルには載らない |
| 配色の持たせ方 | **`styles` を渡す**（`mapId` を使わない） | Maps JS API は両者を排他にしており、`mapId` を渡すと Wakaba の配色が Cloud Console 側の設定に負ける。配色をリポジトリの外へ出すと、移植元と同じ色かがコードから確かめられない |
| 始終点の印 | 旧 `Marker` | `AdvancedMarker` は `mapId` を要求する＝上の決定と両立しない。色は移植元の `BitmapDescriptor` 既定ピン（緑／橙）ではなく、作り物の地図と同じ `--walk` / `--burnt` |
| `variant` | 運ばない | 移植元でも全 3 箇所が既定の `full`。`nav` を使う画面が Web に無い |
| 図形の計算 | Maps API を**知らない層**へ出す（`route-overlays.ts`） | 地図は jsdom に無い。取り違えが起きるのは経路→図形の対応づけのほうで、そこだけ切り出せばテストで押さえられる |
| 破線 | 寸法（dash/gap）のまま持ち、描画側で API の語へ畳む | Maps API に破線のプロパティは無く、線を透明にして点線シンボルを繰り返す。その知識を計算側へ持ち込むと jsdom で読めなくなる |
| キー未設定 | 作り物の地図へ倒す | 移植元も `USE_REAL_MAP` が既定 false で同じ絵を出す。実地図が出ないのは設定漏れの兆候であって、画面の故障ではない |

**作り物の地図は枠を測って 1 単位 = 1px で描く。** 移植元は実ピクセルの `Size` を受け取り、
割合で置く図形（公園・道路・経路）と絶対寸法で置く図形（建物 26x22、ピンの半径、線の太さ）を
混ぜている。SVG で同じことをするには、枠の実寸をそのまま viewBox にするしかない。

はじめ固定 viewBox（360x240）を `slice` で埋めていたが、これは**枠の縦横比が違うぶんだけ
切り落とす**。縦長の背景（360x800）では横 360 単位のうち中央 108 単位しか映らず、公園も建物も
画面外へ出て、絶対寸法の道路だけが 3.3 倍に太っていた（PR #402 の Codex レビュー）。かといって
`preserveAspectRatio="none"` で伸ばすと、今度は建物とピンが枠なりに潰れる——**測るのが両方を
満たす唯一の形**で、移植元が `Size` を受け取っているのはまさにそのため。

`ResizeObserver` の無い環境（jsdom）では既定の 360x240 で描く。

**図形は `route` が変わったときだけ作り直す。** 区間 id（`seg-0`…）だけを見て描き直しを
決めると、代替案の切り替えで区間の構成が同じまま座標だけ変わったとき、古い経路の線が地図に
残り続ける。`useMemo` を `route` に掛けて、effect はその参照を見る。

**Maps API が使えるまでは作り物の地図を描き続ける。** `APIProvider` がやるのはスクリプトを
読みに行くところまでで、読めるまでの間と読めなかったときに代わりの絵は出さない——素通しに
すると result のプレビューと loading の背景がその間まるごと空白になる。移植元の
`supportsRealMap`（`mapsJsLoadedProvider`）と同じ役目を、状態 `LOADED` 以外を倒すことで
持たせている（PR #402 の Codex レビュー）。

ライブラリが遷移させるのは `LOADING` / `LOADED` / `FAILED` の3つだけで、**`AUTH_FAILURE` は
型にあるだけで 1.10.0 はどこからも設定しない**。将来出るようになったときに素通ししないよう
倒す側へ入れてあるが、いま何かを守ってはいない。

そして**キーが無効・制限違反のときはこの経路に来ない**。スクリプトは正常に読めるので状態は
`LOADED` になり、Google が地図の中へ自前のエラー面を描く。こちらから見分ける術は無い
——リファラー制限の設定は `docs/security_hardening.md` の側の話。

**始終点の印は marker ライブラリの取り込みを待つ。** `<Map>` が在ることで保証されるのは
core と maps までで、legacy `Marker` はそこに入っていない。待たずに `new` すると結果画面が
出た瞬間に undefined を呼んで落ちる（PR #402 の Codex レビュー P1）。`useMapsLibrary('marker')`
が返してから作る。`Polyline` のほうは maps ライブラリなので、地図が在る時点で必ず在る
——同じ扱いに見えて、要る待ちが違う。

**loading の背景は `inert`。** `aria-hidden` が外すのは読み上げの木だけで、実キーがあると
ここは本物の地図になり、canvas と Google が差し込む帰属表示のリンクはフォーカスを受け、
ジェスチャーは入力を飲む。読み上げから隠れたままタブで入れる的が残る。

**カメラの合わせ直しは矩形を値で比べる。** `route` は切り替えのたびに作り直され、そこから
計算した矩形も新しいオブジェクトになる。参照で見ると、同じ経路のままカメラが飛ぶ。

**`tsconfig.json` の `types` に `google.maps` を並べた。** `types` を明示している間は
`node_modules/@types` の自動取り込みが効かない。テストは Vite の変換越しで型を見ないので、
ここが欠けても `tsc --noEmit` でしか落ちない（テストは 514 件緑のまま型だけ落ちた）。

**実地図の目視確認はキーを要する。** ダミーキーでも Maps JS API 自体は読み込まれ、polyline と
始終点の印は実 API 越しに描かれることまでは確かめた（タイルだけが認証エラーで灰色になる）。
配色・カメラの寄りは実キーでないと見えない。キーのリファラー制限に開発中のオリジンが
入っていないと、実地図だけが `RefererNotAllowedMapError` で出ない。

## デスクトップ幅の作り分け（#406）

#372 で Flutter 版へ入れた `>= 820px` のレイアウトは #386 では運んでいない。#387 が
`lib/` を消すと参照元が `archive/flutter` にしか無くなり、配信を React へ差し替えた時点で
デスクトップ利用者から見た劣化になるので、**撤去より先に**運ぶ。

### 幅の判定は matchMedia を useSyncExternalStore で読む

移植元は実測幅（`MediaQuery`）を Riverpod の provider へ流し込む注入点を1つ作っていた
（`ResponsiveScope`）。web では `matchMedia` がその1点なので、provider に当たるものは
置いていない。

`useState` + `useEffect` で持たないのは、初回描画が必ずモバイル側になり、デスクトップ幅で
1フレームだけモバイル UI が出てから入れ替わるため。`useSyncExternalStore` は描画の中で
現在値を読む。

**jsdom は `matchMedia` を実装しない**（CSSOM View 未対応。29.1.1 で確認）。本体側で
`typeof` を見て庇うと本番のブラウザでも静かにモバイルへ倒れる経路ができるので、
`test/setup.ts` が「幅を答えない」実装を敷いている。既存の画面テストはこの経路で走る
——デスクトップ分岐を足してもモバイル側の検証はモバイルのまま残る。

### 共通シェルはレイアウトルートに置く

移植元は `DesktopShell` を Navigator の**外**へ置いた。go_router のネスト構造が戻り先
（settings/search/result/error→home）そのもので、`ShellRoute` で包むとその構造に手を
入れることになるからだった。React Router ではネストは `<Outlet>` の入れ子であって履歴を
積まない——戻り先を作っているのは `navigator.ts` の push / replace / pop の使い分けなので、
レイアウトルートで包んでも戻り挙動には触れない。`loader` のガードは子に残す。

タブは `go()` を通す。`router.navigate` を直に呼ぶと子から子への replace も子から home への
pop も失われ、履歴が伸びる。

**待ち画面からタブで離れるときは明示的に打ち切る。** `watchSearchAbandon` は POP だけを
見ており（移植元の `PopScope` が塞いでいた操作そのもの）、push で出ていくタブには掛からない。
移植元の `DesktopShell` が `leave()` で `cancelSearch` を呼んでいたのと同じ穴。

### 画面の「1画面ぶん」は `--screen-min-height`

各画面の `min-height` は `100dvh` 直書きだった。シェルは上部バー（64px）を持っていくので、
そのままだとデスクトップ幅で全画面がバーの高さぶん縦にはみ出す。既定を `theme/base.css` の
`:root` に置き、シェルの本文領域が `100%` へ差し替える。

### 幅の出し分けの入口は2つに分ける

- **DOM から消えるもの・挙動が変わるもの**は `useIsDesktop`（JS）。上部バーそのもの、
  この先の検索欄の作り替えや時刻欄がこれにあたる
- **見た目だけのもの**は CSS のメディアクエリ。中央寄せ・最大幅・列の並べ替え

**移植元の `DesktopContent` に当たる器は作らない。** Flutter は「デスクトップ幅のときだけ <!-- doc-consistency:keep: 移植元（Dart）の widget 名。lib/shared/widgets/desktop_content.dart は健在 -->
最大幅を掛けて中央へ寄せる」をウィジェットでしか表せなかったが、CSS では画面自身の
`.screen` に 3 行書けば済む。`ArukuCard` の引数リストを持ち込まなかったのと同じ判断。

境界の数値は JS と CSS の両方に書くことになるので、`test/layout/breakpoint-css.test.ts` が
一致を固定する——片方だけ動かしても、jsdom は CSS を読まず Playwright は一方の幅しか
見ていないので、どちらの層のテストも赤くならない。

### 幅の両側は Playwright で見る

jsdom は CSS を読まないので、幅による出し分けは単体テストから原理的に見えない
（`useIsDesktop` の両側は `test/layout/` が押さえるが、それが実際の 820px で切り替わることは
別の話）。`e2e/desktop-shell.spec.ts` がブレークポイントの両側・縦のはみ出し・タブ往復後の
履歴の深さを見る。

### home の設定ボタンはデスクトップで出さない

移植元（`lib/features/home/home_screen.dart`）はデスクトップ幅でも歯車を残していたが、
ハンドオフのルート計画に歯車は無く、シェルのタブが同じ行き先を持つ。**移植元とハンドオフが
食い違う箇所で、ハンドオフを採った。**

副作用として `e2e/navigation.spec.ts` はモバイル幅に固定した。あのファイルの主題は履歴の
積み方で、home から子へ出る導線にこの設定ボタンを使っている。既定のビューポートは
Desktop Chrome（1280px）なので、そのままだと押せる要素が無くなって 30 秒待って落ちる。

### 結果画面は左パネル＋全面地図

移植元（`result_screen.dart` のデスクトップ分岐）と同じく、左 380px の固定パネルと右の
全面地図に分ける。**内部スクロールは左パネルだけ。** 一括スクロールにすると下部の導線が
ビューポート固定の分割ビューから押し出される（#262 で踏んだ形）。

DOM を1つだけ足した——合計から下をまとめる器。CSS のグリッドだけでは「ヘッダは固定、
その下だけがスクロール」を作れない（兄弟のまま並んだ要素はまとめてスクロールできない）。
モバイル幅では画面の縦積みの一部で、間隔は親の `gap` と同じ 14px を持たせている。

移植元の左パネル下部にある区間 CTA（`result_leg_cta.dart`）は無い。行程＝歩数同期に依存し、
運ばない側に決まっているもの（上の「まだ運んでいないもの」）。

### 目的地はデスクトップ幅ならその場で決める

移植元 `desktop_typeahead_field.dart` の移植。全画面の検索へ遷移せず、条件カードの中で
確定する。**見た目だけの差ではないので CSS ではなく `useIsDesktop` で分ける**——遷移が
1つ消える。

移植元と変えた点が2つある。

- **確定した地点は入力の値にする。** 移植元は入力を空にして確定名を `hintText`（placeholder）
  へ出していたが、placeholder は読み上げ名にならない——欄が何を指しているかが支援技術から
  消える。`query` が null のとき確定名を映す形にした
- **「近くの店」（#146）を切る処理を持たない。** 移植元はフォーカスのたびに
  `setNearby(false)` していた。あれは全画面検索と検索状態を**共有**していたためで、
  この欄は自前の検索状態を持つので引き継ぐモードが無い

一覧とメッセージは排他。同時に出ると、候補が並んでいるのに「見つかりませんでした」と
書かれた画面になる（実ブラウザで発覚し、退行テストを置いた）。

`e2e/route-search.spec.ts` はモバイル幅に固定した。あのファイルの主導線は全画面の検索を
通る——デスクトップ幅にはその画面が無い。デスクトップ側の主導線は `typeahead.spec.ts` と
`desktop-layout.spec.ts` が通る。

### まだ入っていない画面

シェル・settings（760px・ラベル左列）・error（520px）・result（2カラム）・home の
設定ボタンとインライン検索欄まで。時刻欄の作り直しと loading の全面地図が
#406 の残り。home 自体のデスクトップ版（ハンドオフの条件カード・
「よく歩く目的地」）は、移植元も入れていないので #406 の範囲外。

## 動かす

```bash
npm --prefix apps/web ci
npm --prefix apps/web run typecheck  # 型（CI もこれを回す）
npm --prefix apps/web test           # CI もこれ
npm --prefix apps/web run build      # 本番バンドルの解決まで見る（CI もこれ）
npm --prefix apps/web run dev
```

Node は 22.22.0 以上が要る（`react-router` の要求）。`packages/engine` の `^22.12.0` より厳しい。
