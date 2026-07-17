# NAVITIME → Transit API 置換の設計（#137）

- **ステータス:** 設計確定（実装前）。未計測項目は実機調査済み（§1・§8）。確定したら [route-optimization.md](../spec/route-optimization.md) §2（データ源）・§4（不変条件）と、必要なら [walk-max-board-search.md](walk-max-board-search.md) を更新する。
- **Issue:** #137（NAVITIME `route_transit` を Transit API + 静的 GTFS で置換）。
- **方針転換:** Issue 本文の前提（Transit API から生 GTFS をダウンロードし `stop_times.txt` を解析して静的アセット化）は**実機検証で不成立**（§1）。代わりに `/guidance/plan` の transit polyline を経路コリドーとして使い、**乗車駅探索（引き直し）を主機構に据える**方針へ切り替える。**静的 GTFS バンドル・`GtfsStopRepository`・オフライン生成スクリプト・CI 月次再生成は不要。**
- **関連不変条件:** #65 / #67 / #71 / #115 / #117 / #118 / #121 / 逆戻りフィルタ。本書はこれらを回帰させないことを設計制約とする。
- **関連メモリ:** `project_transit_api_capabilities`。

---

## 1. 実機調査の結論（2026-06-27）

Transit API `https://api.transit.ls8h.com`（OpenAPI: `/api/openapi.json`）の公開エンドポイントは
`/feeds` `/plan` `/guidance/plan` `/locations/suggest` `/places/{suggest,reverse}` `/stations/{id}` `/stations/{id}/departures` `/operators` `/map/3d-scene` `/health` のみ（全 774 フィード）。

### 1.1 確定した制約

1. **生 GTFS のダウンロードは無い。** `/feeds` はメタデータのみ。`downloadUrl` は事業者公式 PDF/サイトで GTFS zip ではない。`/feeds/{id}` 系・`*.zip` は 404。→ Issue Phase 1 は実行不能。
2. **transit leg は途中停車駅を持たない。** leg は `routeName/mode/color/headsign/tripId/from/to/departureSecs/arrivalSecs`。`/departures` は単一駅の発車のみ、`/stations/{id}.routes` は路線名だけ。
3. **運賃は取得できない。** `/plan`・`/guidance/plan` とも `journey.fare`・`leg.fare` が**常に null**（OpenAPI には fare スキーマがあるが実データは空）。→ **運賃表示は失われる**（後述 §5。UI は `seg.fare != null` ガード済みで安全に非表示になる）。
4. **`type` パラメータの enum は英語**：`departure`/`arrival`/`first`/`last`（OpenAPI の説明は日本語表記だが値は英語。`type=出発` は 400）。
5. **レイテンシが大きい。** `/plan` で 5〜8 秒、`/guidance/plan` で 9〜11 秒（ペイロードでなくサーバ側経路計算が支配的。`numItineraries=1` でも変わらず）。→ 乗車駅探索の逐次引き直しに直撃する（§7 リスク）。
   - **裾は 30 秒を超える（2026-07-17 追試・#300）:** 同一パラメータ（`numItineraries=5`）で Mac から 5 回 curl → **10.1 / 12.8 / 30.8 / 21.1 / 12.4 秒**。429 は 0 件、`avoidModes` の有無で有意差なし（当初あるように見えたのは分散）。**9〜11 秒は中央値であって上限ではない。**タイムアウト方針は §8.1 が正本。

### 1.2 途中停車駅の代替＝transit polyline（ただし geometrySource 依存）

`/guidance/plan` の `options[].map.segments[]` の transit セグメントは `geometrySource` 付きの polyline を返す。実測した値は **4 種**：

| geometrySource | 意味 | 頂点=停車駅か | 該当フィード例 |
|---|---|---|---|
| `stopOrder` | 停車駅を順に結んだ折れ線 | **はい（頂点=停車駅座標）** | JR スクレイプ系（中央/東海道/京浜東北/山手…）、東京メトロ(odpt)、名鉄、阪急/阪神 |
| `gtfsShape` | 実 GTFS の線路追従 shape | **いいえ（密な線路頂点）** | 東急・小田急・京王（official GTFS 系 `tokyo-*-rail`） |
| `osmWalk` | OSM 経路の徒歩線 | （徒歩区間） | — |
| `estimatedWalk` | 推定徒歩線（端点直線） | （徒歩区間） | — |

- 検証例: 吉祥寺→中野（各停 6 駅）で `stopOrder` 頂点が**ちょうど 6**＝停車駅と一致。一方、京王 新宿→八王子は `gtfsShape:263 頂点` の線路追従で**停車駅と無関係**。
- **重要:** `gtfsShape` フィードでは途中停車駅が `map.points`（乗降・乗換駅のみ）にも leg にも**どこにも無い**。東急・小田急・京王という大私鉄が該当するため、「停車駅 = polyline 頂点」を全フィードで前提にはできない。

### 1.3 日跨ぎ（終電後）

`date=20260627&time=01:30&type=departure`（終電後）で `resp.date=20260627`・`dep=17640`（=04:54）＝**同日秒で翌朝始発**を返す。API は honest（照会時刻に追従する幽霊便は返さない・実測確認済み）。`departureSecs` が 86400 を超える（24 時超え表記）ケースは未観測だが、深夜 0 時跨ぎ便で起こり得るため実装側で `>86400` を許容する（§4）。

> **実装後の訂正（重要）:** 「要求時刻にアンカーすれば #121 がそのまま機能する」は**標準乗換だけの話**。コリドー座標から合成するハイブリッド電車区間は発車時刻を持たず（距離概算のみ）、乗車待ち 0＝「今夜乗れる」と誤判定され、深夜に**走っていない便が予算内・best-effort へ化けた**（実機: 02:41 京急、23:33 森91）。対策は採用前に実発車時刻を引き直して検証する approach A。詳細は [hybrid-boarding-time-verification.md](hybrid-boarding-time-verification.md)。

---

## 2. データ源の再定義

| 用途 | 新データ源 | 備考 |
|---|---|---|
| 公共交通経路（door-to-door） | **`/guidance/plan`**（クライアント直叩き・認証不要・CORS。`type=departure`） | `options[].journey.legs`＋`options[].map.segments[]`。#135 の地点検索と同じ直叩き。 |
| 経路コリドー（乗車駅候補の母集合） | transit セグメントの **polyline 座標**（geometrySource 不問・§2.5） | stopOrder は停車駅、gtfsShape は線路点。いずれも**順序付きコリドー座標**として使う。 |
| 徒歩の所要・距離・街路ジオメトリ | 現状どおり **Google Routes(WALK)/Matrix プロキシ** | measure-first の実測精度を維持。guidance の osmWalk 代替は別 Issue（§6）。 |
| 運賃 | **取得不可**（§1.1-3） | 運賃表示は廃止（§5）。 |
| 発着時刻 | leg の `departureSecs`/`arrivalSecs`（サービス日 0 時起算秒・`>86400` 許容） | §4。 |

- **`navitimeProxy`（Cloud Function）・RapidAPI 依存は廃止対象。** 徒歩 Google プロキシは維持。
- **`numItineraries`** を増やすと `options` が増える（rail を含まない全徒歩 option も混ざる）。選定は従来どおり候補を同一土俵で比較するので、rail を含む option を候補化すればよい。

### 2.5 乗車駅候補の生成を geometrySource 非依存にする（本設計の要）

乗車駅探索（[walk-max-board-search.md](walk-max-board-search.md)）は「コリドー上の候補乗車駅 X から `plan(X→goal)` を引き直す」方式。X は**厳密に停車駅である必要はない**——X の座標から引き直すと API が最寄り駅にスナップして実在便を返すため。

よって候補 X の母集合を **transit polyline 座標をコリドーとしてサンプリング**して作る：

- **`stopOrder`** フィード: 頂点がそのまま停車駅座標。理想的（従来の calling_at と等価）。
- **`gtfsShape`** フィード: 頂点は線路点だが、コリドーに沿って**間引きサンプリング**して候補座標にする。`plan(X→goal)` がスナップして実在の乗車駅・便を返すので破綻しない。

これで東急・小田急・京王（gtfsShape）でも乗車駅探索が成立し、stopOrder/gtfsShape の差を吸収する。サンプリング座標は origin からの距離（≒前半徒歩 t1）で単調に並ぶため、`maxWalkBoardingIndex` の二分探索前提（t1 単調増）を満たす。

---

## 3. 新アーキテクチャ：`TransitRouteService`

`RouteService` を実装する `TransitRouteService` を新設し、`routeServiceProvider`（[route_service.dart](../../lib/core/services/route_service.dart)）の生成先を差し替える。**選定ロジック（measure-first・乗車駅探索・best-effort 縮退）と純粋関数（`selectBestRoute`/`arrivalMinutes`/`firstMissedTrain`/`maxWalkBoardingIndex`/`frontierStations` 等）はデータ源非依存なので流用。** 置き換わるのは「経路取得＋パース」層だけ。

### 3.1 NAVITIME 版とのマッピング

| NAVITIME 版（現状） | Transit API 版（新） |
|---|---|
| `_fetchTransit`/`_fetchTransitAt`（`navitimeProxy`, `railway_calling_at`） | `/guidance/plan`（`date`/`time`/`type=departure`） |
| `_parseTransit`（sections → segments + `_Stop` 列） | `journey.legs`＋`map.segments[]` をパース |
| `base.stops`（calling_at 由来の停車駅） | transit polyline 座標をサンプリングした候補列（§2.5。座標のみ・name/dep/arr/fare は null） |
| 乗車駅探索 `_buildBoardSearchCandidate`（X→goal 引き直し） | 同左。引き直しは `/guidance/plan` または `/plan`（X→goal, `time=departureAt+t1`） |
| 乗り遅れ再照会 `_refetchMissedTrain`/`_findRealBoarding` | **廃止/縮小**（§4 #115。引き直し方式では `firstMissedTrain` の概念が消える） |
| 運賃 `_fareOf`/`_parseFare`/`_proratedFare` | **廃止**（§5） |

### 3.2 `_Stop` の縮退

polyline 由来の候補は `name=''`・`dep=null`・`arr=null`・`fare=null`・`section`=leg 連番。これは既存実装の「#67 時刻欠落停車駅」と同じ縮退ケース：

- `_rideMinutes` は時刻が無ければ折れ線長 ÷ `trainMetersPerMinute` で概算（既存）。座標があるので機能する。
- `_buildMeasuredHybrids` の `sectionTimed` は「時刻が全く無い区間 → 全停車駅を乗降可」へ倒れる（既存 #67 経路）。通過駅除外は効かなくなるが、**乗車駅探索が引き直しで実在便を得るため通過駅問題は引き直し側で解消**する。
- → ハイブリッド（`_buildMeasuredHybrids`）は時刻を失い概算依存になる。**乗車駅探索を主機構に寄せ、ハイブリッドは補助に格下げ**する（精度は引き直しで担保）。

---

## 4. 不変条件への影響と対応

- **#65（待ち時間を到着へ反映）:** leg の `departureSecs`/`arrivalSecs`（乗降駅の発着）は得られる。失われるのは途中駅の各時刻だけ。タイムラインは乗降駅時刻で足り、**維持可能**。
- **#115（乗り遅れ再照会・再アンカー）:** Transit API では途中駅時刻・駅名が無いので `_findRealBoarding` 方式は使えない。**乗車駅探索（引き直し）一本化**で代替——X 発で引き直すため自己整合で `firstMissedTrain` が立たない（[walk-max-board-search.md](walk-max-board-search.md) §2）。`_refetchMissedTrain`/`_findRealBoarding` は廃止/縮小。
- **#121（終電後の翌朝始発を後回し）:** `maxBoardingWait`/`reachableWithinBudget` は leg の `departureSecs` で判定でき**維持可能**（§1.3 検証済み）。`departureSecs > 86400`（24 時超え）を許容する正規化を入れる（`parseNavitimeJst` 相当の Transit 版＝「サービス日 0 時 + departureSecs」を naive JST 壁時計へ）。
- **#71（運賃按分）:** **運賃自体が取得不可のため廃止**（§5）。`_proratedFare` 系は削除。
- **逆戻りフィルタ:** `_isBacktrackDetour` は polyline が停車駅座標である前提。`stopOrder` は前提に合致。**`gtfsShape` は密な線路頂点で後方カーブ頂点を含み得る**ため誤除外のリスク。→ 逆戻り判定は **leg 端点（乗降駅）＋サンプリング済みコリドー点**で行い、生の gtfsShape 全頂点は対象にしない（§2.5 のサンプリング座標を使う）。

---

## 5. 運賃の扱い（取得不可 → 表示廃止）

`/plan`・`/guidance/plan` とも運賃を返さない（§1.1-3）。代替の公開ソースも無い。よって：

- **運賃表示を廃止する。** [result_timeline.dart:261](../../lib/features/result/result_timeline.dart) は `if (seg.fare != null)` ガード済みなので、`fare=null` で**¥ 表示が出ないだけ**（クラッシュ・レイアウト崩れ無し）。
- `RouteSegment.fare` フィールド自体は当面残してよい（常に null）。将来別ソースを得たとき復活できる。運賃按分ロジック（`_proratedFare`）は削除。
- ※これは**機能後退**。許容するか別途運賃ソースを探すかは要合意（実装着手前に確認）。

---

## 6. 徒歩ジオメトリ：当面 Google 実測を維持

measure-first 選定はアクセス徒歩の Google 実測が精度の根拠。`guidance/plan` の `osmWalk`/`estimatedWalk` polyline で代替できるかは**所要時間の同等性が未計測**。当面は **Google 実測（`googleWalk*` プロキシ）を維持**し、guidance polyline は地図線の補助に留める。Google 依存削減は別 Issue。

---

## 7. 段階的移行計画（1 セッション 1 機能・TDD）

1. **パーサ層の TDD:** 保存した実 `/guidance/plan` JSON フィクスチャから `journey.legs`＋`map.segments[]` を `RouteSegment` 列＋コリドー座標列へ変換する純粋関数（`_parseTransit` 相当）。geometrySource 別の polyline 解釈・`departureSecs>86400` 正規化を含めテストで固める。
2. **`TransitRouteService` スケルトン:** `/guidance/plan` を叩き標準経路のみ返す最小 `RouteService`。`routeServiceProvider` をフラグ切替にし NAVITIME と並走検証。
3. **コリドーサンプリング＋乗車駅探索接続:** §2.5 のサンプリングで候補 X 列を供給し、`_buildBoardSearchCandidate` の引き直しを Transit API へ。`maxWalkBoardingIndex` は流用。
4. **#121/#65 の時刻整合:** leg 発着時刻で `maxBoardingWait`/`reachableWithinBudget`/タイムラインを検証。日跨ぎ正規化を確認。
5. **運賃廃止（§5）と #115 整理:** `_proratedFare`/`_refetchMissedTrain`/`_findRealBoarding` を削除/縮小。
6. **NAVITIME 撤去:** `NaviTimeRouteService`・`navitimeProxy`・RapidAPI シークレット/依存を削除。`route-optimization.md` §2 を更新。

> 各ステップ完了時に `dart format .` / `dart analyze` / `flutter test`。`feat/137-...` ブランチで PR 化（main 直コミット禁止）。

---

## 8. 残リスク・未計測（実装中に潰す）

- [x] **レイテンシ（最大の懸念）:** 1 経路 = 初期 guidance(~10s) ＋ 乗車駅探索の逐次引き直し（O(log n)＋検証数駅 × 5〜10s）で **合計 30〜60s** になり得る。→ **実測で顕在化し #300 で方針確定。§8.1 が正本。**
- [ ] `osmWalk`/`estimatedWalk` の所要・距離が Google WALK と同等か（§6）。
- [ ] `departureSecs > 86400`（0 時跨ぎ便）が実際に返るか・その表現。
- [ ] gtfsShape サンプリング粒度（何 m 間隔で候補化すれば乗車駅探索の取りこぼしが無いか）。
- [ ] gtfsShape フィードの全体割合（東急/小田急/京王以外にどれだけあるか）。
- [ ] カバレッジ: `coverage.notices`「未収載路線は候補に含まれない」。NAVITIME 比で主要路線が十分か。

### 8.1 タイムアウト方針（#300・確定）

**前提:** 上流は第三者の**無料・無認証・匿名**の公開 API で、契約も SLA も交渉手段もない。**遅さは相手の性質であり、動かせるのは我々側だけ。**

**症状:** 実機（profile）で経路検索が「通信に失敗しました」で失敗し続けた。App Check・レート制限・端末は無関係（429 は 0 件、Cloud Functions のログにも 401/429 なし）。真因は `TimeoutHttpClient` の既定 **15 秒**を Transit API 直叩きと Google プロキシで共有していたこと。正常時（9〜11 秒）ですら余裕が約 4 秒しかなく、必須の初期 `/guidance/plan` が 1 本超えれば検索全体が落ちる（§1.1-5 の裾は 30 秒超）。

**確定した3層:**

| 層 | 値 | 役割 | 根拠 |
|---|---|---|---|
| Transit 直叩き1本 | **35 秒** | ハング検出 | 実測5サンプルの最大 30.8 秒を収める。裾を「切る」より「待つ」——上流を速くする手段が無い以上、切れば単に失敗が増える |
| 徒歩プロキシ1本 | **15 秒**（据置） | ハング検出 | Cloud Functions 経由の Google Routes は同じ裾を持たない。無応答は本当に異常＝早く縮退した方が良い（徒歩は直線推定へ落とせる） |
| 検索全体 | **120 秒** | 体感保証 | 正常時 30〜60 秒の上に裾（30 秒級）が数本重なっても引き直しを完走できる幅を残し、最悪をそこで止める |

**なぜ1本の上限だけでは足りないか（この issue の設計上の要点）:** 引き直し（乗車駅探索・代替検証）は `on RouteException` → null で縮退するが、**縮退する前に上限いっぱい待つ**。直列ラウンドは初期 guidance → board-search（`O(log₄ n)`）→ 実時刻解決 → 代替検証 → 駅名確定でおよそ 6〜9 段あり、最悪待ち時間は「上限 × ラウンド数」で効く。15→35 秒の延長は、そのまま最悪 150 秒→350 秒を意味した。**1本の上限（ハング検出）と検索全体の締切（体感保証）は別レイヤーに分ける必要がある。**

**天井を厳密に 120 秒へ落とす仕掛け:** `SearchDeadline` を `TransitApiClient` に渡し、**各 fetch を `min(1本の上限, 締切の残予算)` でクランプ**する（`_getOrTimeout`）。新ラウンドを止めるだけでは最悪が「締切＋1本の上限」＝155 秒になる。残予算 0 での照会は HTTP を発行せず即 `TIMEOUT`（必ず打ち切られる照会で無料の上流を叩かない）。

**非対称性が方針を支えている:** 必須なのは初期 `/guidance/plan` **1本だけ**で、引き直しは徒歩最大化のための**改善**。だから締切は改善側だけをゲートし、初期照会は止めない（止めれば #300 の症状へ戻る）。締切超過は**失敗ではなく縮退**で、既得の候補で確定経路を返す。

**トレードオフ（承知の上）:** 締切で board-search が打ち切られると徒歩が最大より短くなる＝アプリの主目的が静かに劣化する。これを許容するのは、上流が遅い日に「劣化した経路を 120 秒で返す」方が「正しい経路のために 300 秒待たせる／失敗する」より良いという判断。劣化の頻度が問題になるなら、締切を伸ばすのではなく**ラウンド数を減らす**（サンプリング粒度・`_maxAlternativeValidations`）方向で対処すること——締切を伸ばすのは体感を売るだけで、上流の裾は変わらない。

**UI 文言:** `TIMEOUT` は `RouteErrorKind.network` から分離した（`RouteErrorKind.timeout`）。従来は 401 も 429 もタイムアウトも「通信に失敗しました」へ丸めており、#300 の切り分けでは画面表示から App Check 拒否・レート制限・上流遅延を区別できないこと自体が障害になった。HTTP ステータス別（401/429）の分離は範囲が広いため別 issue。

---

## 9. 検証ポイント

- [ ] 主要回帰区間（蒲田→上野ほか）で乗車駅探索が NAVITIME 版と同等の徒歩最大化になるか。
- [ ] gtfsShape 区間（東急/小田急/京王）で §2.5 のサンプリング乗車駅探索が成立するか。
- [ ] 急行・各停混在路線で候補が正しく取れるか。
- [ ] 乗り継ぎ経路で停車駅が正しい leg/section に割り当たるか。
- [x] 終電後・深夜帯で #121 の翌朝始発後回しが維持されるか。→ **標準乗換は維持。ただし時刻なしハイブリッドは別途検証が必要だった**（approach A で対応・[hybrid-boarding-time-verification.md](hybrid-boarding-time-verification.md)）。
- [ ] 地図線（polyline）が全区間で描画されるか（従来 shape 欠落の解消）。
- [ ] 運賃非表示が許容範囲か（§5）。
