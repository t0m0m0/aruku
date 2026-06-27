# ルート最適化 仕様（正本）

- **位置づけ:** 本書はルート最適化ロジックの **仕様の正本（source of truth）**。挙動を変える実装・レビュー・再設計は本書を基準に判断し、仕様が変わったら本書を更新する。
- **最終更新:** 2026-06-18
- **対象コード:** `lib/core/services/navitime_route_service.dart`, `lib/core/services/hybrid_route_selector.dart`, `lib/core/services/route_plan_builder.dart`, `functions/src/`
- **関連:** [ADR-001](../adr/ADR-001-route-optimization-architecture.md)（アーキテクチャ決定）, [optimization-backend-offload.md](../notes/optimization-backend-offload.md)（再設計の検討メモ・限界分析）
- **実装ステータス:** アーキテクチャは反応的「実測ループ」方式から **measure-first（測ってから選ぶ）** へ移行中。§4 の不変条件・§5 の純粋関数契約は実装方式に依存しない恒久的な正本。§3 のアーキテクチャは採用済みの目標設計。

---

## 1. 目的と目的関数

「指定した制限時間（予算）内で最大限歩く」ルートを提示するアプリ。**運動量の最大化が主眼**で、電車は「歩きでは間に合わない区間を補う手段」。

- **目的関数:** 到着時刻 ≤ 締切（予算）を**制約**に、**徒歩時間 `walkMinutes`（分）を最大化**する。
  - タイブレーク: `walkMinutes` が同じなら**実到着が早い**候補を選ぶ。
  - kcal は徒歩距離から算出（`kcal = walkKm × kcalPerKm`、`kcalPerKm = 57`）。表示用で選定には使わない。
- **km か min か（限界1・確定済み）:** 選定は **`walkMinutes`（時間）を正**とする。[ADR-001](../adr/ADR-001-route-optimization-architecture.md) は `walkKm` と記すが、これは実装（`walkMinutes`）に合わせて修正する。
  - 理由: measure-first ではアクセス徒歩を**実測**するため、`walkMinutes` は街路追従の実所要時間になる。旧方式で `walkMinutes` を歪めていた迂回率割増（`_inflateWalk`）は撤廃されるので「クネクネして時間がかかるだけの経路」が不当に勝つ問題は起きない。
- **予算内候補が無いとき（best-effort）:** 最長（全徒歩）ではなく**実到着が最早**の候補へ縮退する（UI バナーの「最短を表示」と整合）。ただし「今夜は乗れない」電車（終電後の翌朝始発など）は後回しにする（§4 #121②）。

---

## 2. データ源とその制約

| 用途 | データ源 | 制約・理由 |
|---|---|---|
| 公共交通経路 | **NAVITIME route_transit**（RapidAPI、プロキシ経由） | Google Routes/Directions API は**日本の公共交通ルートを返さない**ため不可。NAVITIME を正とする。 |
| 徒歩の所要・距離・街路ジオメトリ | **Google Routes API** `computeRoutes`(WALK) / `computeRouteMatrix`(WALK)（プロキシ経由） | **NAVITIME は徒歩 shape（街路ジオメトリ）を返さない**。停車駅座標(calling_at)のみ取得可。徒歩線・実所要は Google から得る。 |
| 地図表示 | `google_maps_flutter`（ネイティブ Google Maps SDK） | SDK がアプリ起動時にキーを読み地図タイルを直接取得。**地図用キーはアプリ内に必須**（コードで制御不可）。 |

### 2.1 バックエンド（Firebase Functions・薄いプロキシ）

`functions/src/` の HTTP 関数。**計算ロジックは持たず**、横断的関心事のみ担う。すべて `asia-northeast1`（日本からの往復遅延最小化）。

| エンドポイント | プロキシ先 |
|---|---|
| `navitimeProxy` | NAVITIME route_transit（基本素通し） |
| `googleWalkProxy` | Google Routes `computeRoutes`(WALK)（基本素通し） |
| `googleWalkMatrixProxy` | Google Routes `computeRouteMatrix`(WALK)（基本素通し） |

- **地点検索（#135）:** 公開・無認証の Transit API（`api.transit.ls8h.com` の `places/suggest`）へクライアントから直接アクセスする。Google Places 依存と `placesProxy`・変換層は廃止済み。

- **APIキー秘匿:** Secret Manager（`GOOGLE_MAPS_API_KEY`, `NAVITIME_RAPIDAPI_KEY`）。地図用キーとプロキシ用キーは Cloud Console で分離。
- **認証:** App Check トークン必須（`X-Firebase-AppCheck`）。エミュレータは除外。
  - 注意: App Check 保護は `allUsers` invoker を前提とする。invoker 欠落で 403 になりアプリごと弾かれる。
- **レート制限（IP単位）:** 標準 `30 req/min`、徒歩系 `90 req/min`（1検索のファンアウト対応）。本番は Firestore トランザクション。
- **マトリクス要素数上限:** `origins × destinations ≤ 25`（`MATRIX_MAX_ELEMENTS = 25`）。要素数課金の暴発防止。**measure-first のフロンティア絞り込みはこの上限が設計制約**。

---

## 3. アーキテクチャ（measure-first・採用設計）

[ADR-001](../adr/ADR-001-route-optimization-architecture.md) の方式A'（ハイブリッド）を踏襲：**地図はクライアント／外部APIはプロキシ経由／最適化ロジックは端末側 Dart**。`RouteService` 抽象（`lib/core/services/route_service.dart`）で方式を差し替え可能。

### 3.1 `plan()` のデータフロー

```
NAVITIME route_transit 照会（1回）
  → _parseTransit で各経路を解析（停車駅タイムライン付き）
  → 基準経路 _baseForHybrid（停車駅2以上で最短）
  → frontierStations で乗降候補駅を直線フロンティアで上位 K に絞る
  → _measureAccessWalks: 1回（最大2コール）のマトリクスで
       origin→{各乗車駅, goal} と {各降車駅}→goal を一括実測
  → 実測値で候補生成（標準乗換／ハイブリッド／全徒歩）
  → selectBestRoute で決定的に予算内徒歩最大を選定
  → 採用候補を enrich（街路実測）で検証：
       ・乗り遅れがあれば乗車駅の時刻表を再照会し実在列車へ差替え（#115・NAVITIME 版）
       ・enrich で (a) 予算超過、または (b) 先頭電車に乗り遅れ（標準乗換のアクセス徒歩が
         実街路で伸び駅着が発車後になる・#137）が判明したら除外して乗れる次善へ選び直す
  → 確定が「崩壊」なら乗車駅探索フォールバック（§3.6）→ 候補追加して再選定
  → buildRoutePlan で RoutePlan 構築
```

- **往復回数:** NAVITIME(1) + マトリクス(2並列) + 勝者 enrich(1) + 任意の再照会。マトリクスが成功した通常ケースは検証が初回で通り、逐次 1〜2 往復で収束（旧方式の最大8+回から削減）。
- **「測ってから選ぶ」の要点:** 直線推定で先に絞り（フロンティア）、**実測してから決定的に選ぶ**。反応的な迂回率学習・割増ヒューリスティック・境界帯を持たないため、座標バリア（川・線路）も直線でなく実測で最初から織り込まれる。採用候補の enrich 検証は「予算内候補がある限り超過を返さない」不変条件（#117/#118）を matrix 失敗時にも保つための少回数の安全網で、通常は1回で確定する。

### 3.2 候補の種別

1. **全徒歩:** origin→goal。実測（無ければ直線推定にフォールバック）。常に候補。
2. **標準乗換:** NAVITIME が返した経路そのまま。アクセス徒歩は **NAVITIME 由来（街路ベースで実測相当）のため再測定しない**。
3. **ハイブリッド:** 基準経路の途中駅で乗降し、アクセス徒歩を実測で割り当てた候補。同一乗車区間（section）内・乗車駅 b より後方の降車駅 a のペアのみ（乗換またぎは単一乗車として表現できないため除外）。

### 3.3 フロンティア絞り込み `frontierStations`（設計の肝）

- 乗車側は `origin→駅`、降車側は `駅→goal` の**直線徒歩分が予算内**の駅だけを feasible とする。直線（haversine）は道なり徒歩の下限なので、直線ですら予算超過なら確実に予算外＝実測しても無駄。逆に直線が予算内なら、予算の大半を1本のアクセス徒歩に使う候補（短い乗車＋長い徒歩）も残すため、**道なり迂回の割増は掛けない**（掛けると徒歩最大の正当な候補を誤って落とす）。
- feasible な駅が **片側 `_maxMatrixSideStations`(=10) を超えれば均等間隔で間引く（両端を含む）**（要素数課金 ≤ 25 の範囲。乗車側コールは `origin→{各乗車駅, goal}` の 上限+1 要素）。徒歩分降順の top-K だと乗車側＝origin から遠い駅・降車側＝goal から遠い駅という**互いに逆相関**の集合になり、同一 section・`b<a` の乗降ペアが作れず「中間駅で短く乗り両端を長く歩く」徒歩最大候補（ride-one-stop）を取りこぼす。両端＋中間を均等に残せば長い片側徒歩（両端）も ride-one-stop（中間）も拾い、両側のインデックス域が重なって `b<a` ペアを保つ。
- 純粋関数。Google を呼ばない。実測（マトリクス）の楽観/過大は採用候補の enrich 検証（§3.1）が是正する。

### 3.4 旧方式（撤廃）— 知識の保全

旧 `plan()` は反応的方式だった：直線推定で候補を絞り、確定経路を Google 実測し、超過したら迂回率を学習して選び直す **8回ループ**。

- `_finalize` の最大8回ループ、側別迂回率学習（`_learnDetours`/`_inflateWalk`・#117）、境界帯マトリクス（`_measureFrontierBand`・#118）で構成。
- **撤廃理由（限界2〜5、詳細は[検討メモ](../notes/optimization-backend-offload.md)）:** 候補が最速1本にアンカーされ探索空間が狭い／8回上限で徒歩最大に届かず速い経路へ縮退する品質バグ／迂回率学習が過大に倒れ歩かない側へバイアス／直線前提でバリアに空振り。
- measure-first はこれらを「先に実測して決定的に選ぶ」ことで解消する。#117/#118 が解いていた問題（実測超過・フロンティア取りこぼし）は、**常にマトリクス先行で実測する**ことに一般化・吸収される。#117/#118 の不変条件「予算内候補がある限り超過を返さない／除外は実測の確認時のみ」は、採用候補の enrich 検証ループ（§3.1。学習も帯も持たず通常1回）が引き継ぐ。

### 3.5 バックエンド移管（先送り）

「重いロジックをバックエンドへ」という案があるが、**CPU は軽く本当のボトルネックは外部APIの逐次往復**。measure-first で往復が 1〜2 回に畳まれるため当面不要。着手するなら実機の実測レイテンシ計測が前提（[検討メモ](../notes/optimization-backend-offload.md)）。`RouteService` 抽象で後から差し替え可能。

### 3.6 乗車駅探索フォールバック（崩壊時のみ・徒歩最大化）

詳細・実機実証は [walk-max-board-search.md](../notes/walk-max-board-search.md)。基準経路（最速1本）に依存する measure-first は、徒歩を増やす＝乗車を遅らせる候補が借用時刻表に乗り遅れ、#115 再アンカーも route_transit のデータ源制約で詰むことがある（蒲田→上野公園で徒歩3分・余裕137分へ縮退）。この**崩壊**時だけ走らせる限定フォールバック：

- **起動条件（崩壊判定 `_isCollapse`）:** 確定（enrich 後＝乗れない hybrid 脱落後）が、(1) 予算内標準乗換の最大徒歩を僅少（`_collapseWalkMarginMin`）しか上回らず、(2) 予算を大きく余らせている。両方を満たすときのみ。崩壊でなければ既存のハイブリッド／標準で足り、探索の往復を払わない。
  - **症状(2)の「大きく余る」は相対・絶対のいずれか（#137）:** 余りが予算の `_collapseSlackRatio`（40%）**以上**、または余りが `_collapseSlackMinutes`（30分）**以上**。相対比だけだと予算が大きいとき（例: 予算147分・余り50分）に閾値58.8分へ届かず起動せず、絶対的には大きな余りでも徒歩最大化が silent に不達になっていた。絶対値条件で塞ぐ。
- **探索（実測駆動の二分探索・#137 で改訂）:** 各駅 X から `route_transit(X→goal, departureAt+t1)` を引き直し（X 発の自己整合な実在便なので構成上 firstMissedTrain が立たない＝再アンカー詰みを回避）、「到着が予算内の最遠の乗車駅＝総徒歩最大」を `maxWalkBoardingIndex`（§5）で二分探索する。**前半徒歩 t1 は Google 実街路で実測して二分探索を駆動する**（`_tryWalk`・`walkCache` 共有）。返す境界はそのまま実測で予算内が保証された最遠の乗車駅で、採用後の enrich でも同一レッグはキャッシュヒットして到着が覆らない。
  - **なぜ直線推定で駆動しないか（旧「二段構え」の撤廃理由）:** 旧実装は (1) 直線推定で二分探索し概略境界を出し、(2) 境界から固定段数 `_boardSearchVerifySteps` だけ手前へ実街路で確定する二段構えだった。直線は実街路に対し大きく楽観に倒れることがあり（実機で **-36分・25%**）、二分探索が目的地寄りの遠い駅へ収束 → 実街路では全部予算超過 → 固定段数の後退では真の境界（ずっと手前）に届かず `null` を返し、徒歩最小の標準乗換へ崩落（**徒歩12分・余り114分**等）していた。実測で二分探索を駆動すれば境界が一発で正しく定まるため、二段構え・`_boardSearchVerifySteps` は不要になり撤廃した。
- **解像度:** コリドー候補点（`_maxCorridorStops`）が疎だと境界の隣接候補が大きく離れ、徒歩を予算ぎりぎりまで詰められず余りが残る（旧値 25 で隣接約30分徒歩・余り30分の実例）。実測駆動でも評価は `O(log n)` のままなので候補点を密に（60）して解像度を上げた。
- **実機実証（蒲田→上野公園・180分）:** 田町(169)へ寄せ**徒歩6分→154分・余裕11分**を確定。詳細は [walk-max-board-search.md §6.4](../notes/walk-max-board-search.md)。
- **#115 との関係:** 乗り遅れ再照会（#115）は基準経路の採用候補1本の救済、本フォールバックは候補生成のやり直し。崩壊時のみ後者が補う。

---

## 4. 不変条件・エッジケース（恒久の正本）

実データの汚さ（時刻欠落・運賃按分・乗り遅れ・座標バリア・深夜帯・タイムゾーン）への実戦的対応の集積。**どの実装方式でも必ず守ること。** 各項は対応 Issue 番号で追える。

### #65 — 乗車前・乗換待ちをタイムラインに反映

- 電車区間は乗車駅の発車（dep）・降車駅の到着（arr）の**絶対時刻**を持つ。到着時刻は乗車前・乗換の**待ち時間を含めて**算出する。
- 乗降の絶対時刻は **move セクション直下の `from_time`/`to_time`** を採用する。`calling_at` は途中通過駅のみで乗降駅を含まないため、`calling_at` 先頭/末尾を使うと「乗車駅→1駅目」「最終途中駅→降車駅」のぶん時刻が早まる。move 直下が欠落したときだけ `calling_at` の先頭 dep・末尾 arr へフォールバックする。

#### タイムライン表示（駅ごとに着/発を分ける・案B / Google マップ準拠）

- 左カラムの時刻は **乗車駅＝発車時刻（dep）**、**降車駅＝到着時刻（arr）** を出す。`buildRoutePlan` が区間境界ごとにノードを出し分ける（[route_plan_builder.dart]）:
  - 徒歩で着いて次が電車（乗車駅）→ **発**行（発車時刻＋路線名／○分待ち）。
  - 電車で着いて次が徒歩（降車駅）→ **着**行（到着時刻＋「徒歩へ」）。
  - **電車→電車で間に徒歩が無い直結乗換**でも「着」「発」の **2 行**に分ける。着行は `TimelineNode.cardBelow=false`（無表示・カードを挟まない）で、次の発行へ短いコネクタで繋ぐ。
- 表示時刻は累積分ベース（`formatClock(departure, 累積分+待ち)`）で算出し、乗り遅れ・時刻欠落は駅着時刻へ化す（`_advance` と同基準）。発着時刻はこの左カラムに集約し、**区間カード内には「HH:MM発 → HH:MM着」を重複表示しない**。

### #67 — calling_at の時刻欠落でも停車駅を残す

- プロキシ/RapidAPI 由来データは時刻が欠けることがある。**座標があれば停車駅を捨てない**（捨てるとハイブリッド候補が生成されず予算が余る）。
- 時刻が無い区間の乗車時間は停車駅折れ線長を `trainMetersPerMinute`(=500) で割って概算する。

### #71 — ハイブリッド運賃の距離按分

- 途中駅から短く乗るハイブリッドにセクション全体の運賃をそのまま使うと過大。**セクション運賃を乗車区間の鉄道距離 ÷ セクション全体の鉄道距離で按分**する。運賃が取れない区間は null 許容。

### #115 — 乗り遅れ電車の再照会と差し替え

- 確定しかけた**予算内候補**が予定列車に乗り遅れる（駅到着が発車後）なら、**乗車駅からの時刻表を NAVITIME に再照会**し、実在の後続列車の発着で当該区間を差し替えて実到着を再判定する。
- 同一路線・同一降車駅・乗車区間内に限る（MVP）。多区間で下流接続が崩れる場合や実在列車を確認できない場合は**候補ごと除外**する（乗れない列車を確定しない・安全側）。

### #116 — 徒歩実測のレッグ単位キャッシュ

- 採用経路の徒歩実測（enrich）は plan() スコープでレッグ（start|goal 座標を小数5桁丸めしたキー）単位にキャッシュ。**失敗（null）は負キャッシュしない**（一時的な通信失敗が検索全体へ波及しない）。

### #121 — 深夜帯・日跨ぎ・タイムゾーン

- **①日跨ぎ:** 出発の絶対時刻 `departureAt` は **ユーザー選択の壁時計値そのもの**を持つ naive DateTime（TZ 変換しない）。これを基点に待ち時間を算出するため端末 TZ に依存しない。`dateOffset`（翌日など）を反映。
- **②終電後の翌朝始発:** 「待てば乗れるが今夜は乗れない」電車を「今夜乗れる」と誤判定しない。best-effort 選定では各電車の**乗車待ち（`maxBoardingWait`）がすべて予算内**かつ**乗り遅れ（`firstMissedTrain`）が無い**候補（全徒歩は待ち0で常に含む）だけを残す（`reachableWithinBudget`）。
- **TZ 正規化:** NAVITIME の時刻文字列（`+09:00`/`Z` 付き等）は `parseNavitimeJst` で **JST の壁時計値を表す naive DateTime** へ正規化する。これを怠ると JST 以外の端末で乗車待ちが負＝0 に化け、翌朝始発が深夜電車として表示される。
- **NAVITIME 時刻を信じる（B案）:** 深夜帯の「幽霊便」対策として untimed 電車を時間帯で予算外にする案は**不採用**（始発も消してしまう・#67 と衝突）。NAVITIME が返す発着時刻を正とする。`is_timetable` は判別に使えない。
- 注意: 出発アンカー（naive）と NAVITIME 時刻（`+09:00`→`DateTime.parse` で UTC）を直接 `difference` すると端末 TZ ぶんずれる。必ず `parseNavitimeJst` で揃える。

### 逆戻りフィルタ

- `origin`/`goal` 指定時、電車区間が出発地より進行方向（origin→goal）の**後方へ `maxBacktrackRatio`(=0.15) × 直線距離(origin→goal) を超えて戻る**候補を選定前に除外（例: 蒲田→川崎→品川 の川崎経由）。徒歩区間は判定しない。全候補が逆戻りなら除外せず最短へ縮退。

---

## 5. 純粋関数の契約（テストの正本）

これらは外部 IO を持たない純粋関数で、入出力契約として手厚くテストする。**契約（シグネチャと意味）を変えるときは本書とテストを同時に更新する。**

| 関数 | 置き場所 | 契約 |
|---|---|---|
| `selectBestRoute(candidates, budgetMin, {origin, goal, departureAt, maxBacktrackRatio})` | hybrid_route_selector.dart | 逆戻り除外 → 予算内（実到着 ≤ budget）で `walkMinutes` 最大（同点は実到着最早）→ 予算内皆無なら今夜乗れる範囲の実到着最早。 |
| `reachableWithinBudget(candidates, budgetMin, departureAt)` | hybrid_route_selector.dart | 乗車待ちが予算内 かつ 乗り遅れ無しの候補のみ。該当無しは null。 |
| `maxWalkBoardingIndex({count, budgetMin, evaluate})` | hybrid_route_selector.dart | 乗車駅探索（[walk-max-board-search](../notes/walk-max-board-search.md)）。到着が index 単調増の前提で `evaluate(i) ≤ budget` の最大 index（＝総徒歩最大）を二分探索。evaluate を O(log count) 回に抑える。予算内皆無・count 0 は null。 |
| `buildRoutePlan({from, to, segments, departure, budgetMin, departureAt})` | route_plan_builder.dart | segments → RoutePlan（totalKm/walkKm/kcal/walkRatio/totalMin/timelineNodes）。待ち時間込みの到着を計算。 |
| `arrivalMinutes(segments, departureAt)` | route_plan_builder.dart | 乗車前・乗換待ちを含む実到着分。departureAt 無しは待ち抜き合計。 |
| `firstMissedTrain(segments, departureAt)` | route_plan_builder.dart | 駅着が発車後になる最初の電車区間（index, cumBefore）。無ければ null。 |
| `maxBoardingWait(segments, departureAt)` | route_plan_builder.dart | 全電車区間の乗車前待ちの最大値。 |
| `frontierStations(stops, origin, goal, budgetMin, {maxPerSide})` | navitime_route_service.dart | 乗降候補駅を直線徒歩が予算内のものへ絞り、片側 maxPerSide を超えれば均等間引き（両端含む・b<a ペアを保つ）。昇順インデックスで返す。 |
| `parseNavitimeJst(raw)` | navitime_route_service.dart | `+09:00`/`Z`/オフセット無しを JST 壁時計の naive DateTime へ正規化。不正・null・空は null。 |
| `RouteCandidate` | hybrid_route_selector.dart | `walkMinutes`/`walkKm`/`totalKm`/`totalMin` を segments から導出。データ源非依存。 |

---

## 6. 主要定数

| 定数 | 値 | 用途 |
|---|---|---|
| `kcalPerKm` | 57 | 徒歩1kmあたり消費カロリー |
| `walkMetersPerMinute` | 80 | 徒歩速度（直線推定・フロンティア判定） |
| `trainMetersPerMinute` | 500 | 電車速度（時刻欠落時の乗車時間概算） |
| `maxBacktrackRatio` | 0.15 | 逆戻り迂回の許容比（× 直線距離） |
| `_maxMatrixSideStations` | 10 | マトリクス片側の駅数上限（要素数 ≤ 25） |
| `_maxEnrichAttempts` | 8 | 採用候補の enrich 検証で選び直す試行上限（#115 再照会・超過是正） |
| `_collapseWalkMarginMin` | 10 | 乗車駅探索フォールバック（§3.6）の崩壊判定: 確定徒歩が標準乗換をこの分数以下しか上回らない |
| `_collapseSlackRatio` | 0.4 | 同上の崩壊判定（症状2・相対）: 確定が予算をこの割合以上余らせている |
| `_collapseSlackMinutes` | 30 | 同上の崩壊判定（症状2・絶対・#137）: 確定がこの分数以上余らせている。相対比と OR で判定 |
| `_maxCorridorStops` | 60 | 乗車駅探索のコリドー候補点の上限（均等間引き）。密なほど境界解像度が上がり余りが減る。二分探索は実測 walk 駆動で評価は O(log n)（§3.6・#137） |
| `MATRIX_MAX_ELEMENTS`（プロキシ） | 25 | マトリクス要素数上限（課金暴発防止） |
| レート制限 | 30 / 90 req/min | 標準 / 徒歩系（IP単位） |

---

## 7. 変更時の指針

- **挙動を変える変更は §4 の不変条件を回帰させていないか確認する。** これらは実データのエッジケースへの対応であり、リファクタや再設計で最も壊れやすい。
- 純粋関数（§5）の契約を変えるときは本書・テスト・[ADR-001](../adr/ADR-001-route-optimization-architecture.md) の整合を取る。
- 目的関数（§1）は `walkMinutes` を正とする。距離/時間のどちらを最大化するかは設計の根幹なので、変えるなら本書と ADR を更新してから。
- データ源の制約（§2）— 「公共交通は NAVITIME」「徒歩ジオメトリは Google」「地図キーはアプリ内必須」— は外部 API の仕様由来。transit 不具合はまずこれらの制約を疑う。
