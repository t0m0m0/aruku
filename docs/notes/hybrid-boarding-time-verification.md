# 時刻なしハイブリッドの実発車時刻検証（深夜の幽霊便対策・#137）

- **ステータス:** 実装済み（commit `2939d01` / `cf95882` / `2f66959`、branch `feat/137-guidance-plan-parser`）。
- **対象コード:** `lib/core/services/transit_route_service.dart`、`lib/core/services/route_plan_builder.dart`（`_advance`）、`lib/core/models/route_plan.dart`（`RouteSegment.copyWith`）。
- **正本との関係:** [route-optimization.md](../spec/route-optimization.md) §4 の不変条件に「時刻なし電車を確認できない限り提示しない」を追加。深夜帯の扱いは #121 を補完する。
- **関連:** [transit-api-migration.md](transit-api-migration.md)（#137 Transit API 置換の設計）、メモリ `project_transit_api_honest_hybrid_ghost`。

---

## 1. 症状

深夜（終電後）に経路検索すると、**実在しない電車・バス便**が予算内ルート／best-effort 縮退先として提示された。

- 実機例1: 出発 02:41 で「走っていない京急本線」が予算内候補に。
- 実機例2: 出発 23:33 で「**都立大学 0:48発 森91**（実際は翌朝まで運行なし）」が最短経路として提示。

ログ上の指紋は **電車区間がすべて `maxWait=0m`**。つまり「駅に着いた瞬間に乗れる＝待ち0分」と評価されていた。

## 2. 原因の切り分け（実 API を叩いて確認）

「Transit API が照会時刻に追従する幽霊便を返している（旧 NAVITIME RapidAPI の既知挙動）」と推測したが、**実 API を分刻みで叩いて否定**した。

- 大岡山・長原・都立大学→学芸大学などを深夜 00:30〜01:30 で照会 → 発車時刻は**照会時刻に追従せず実始発（05:00 台）で固定**。例: 都立大学→学芸大学を 01:08 照会 → 先頭は all-walk、電車は朝 05:07。
- 結論: **現行 Transit API（`/guidance/plan`）は honest**。幽霊便は API ではなく**アプリのロジックが生成**していた。

> 教訓: 旧 NAVITIME 時代の「幽霊便」知識（メモリ `project_navitime_daytime_real`）で推測断定せず、まず実 API を叩いて切り分ける。

### 真因＝時刻なしハイブリッド

徒歩最大化のためアプリは標準ルートの経路コリドー座標を分割して**ハイブリッド候補**を合成する（`_buildMeasuredHybrids`）。この電車区間は座標と路線名と**距離概算 `minutes`** は持つが、**発車時刻 `depTime` を持たない**（コリドー座標に時刻情報が無いため）。

`depTime == null` だと到着計算 `_advance`（route_plan_builder.dart）は乗車待ちを **0 分**として扱う。

- 昼間: 数分待ちなので待ち0でも概ね妥当。
- 深夜: 本当は始発まで数時間待つのに「待ち0で今すぐ乗れる」と評価 → 走っていない便が予算内・最善候補に化ける。

`maxBoardingWait`（#121 の「今夜乗れる」判定 `reachableWithinBudget` の基準）も `depTime == null` だと 0 を返すため、best-effort 縮退でも幻便が「今夜乗れる」と誤判定されて素通りした。

## 3. 対策＝approach A（実発車時刻の後付け検証）

採用しそうな候補の時刻なし電車区間について、**その乗車座標→降車座標を実 boardAt で `/guidance/plan` へ引き直し、最初の電車 leg の実発着時刻を当てる**（`_resolveBoardingTimes`）。引き直し便は boardAt 以降発の実ダイヤなので、乗車待ち（始発までの長い待ち）が `arrivalMinutes` に反映され、深夜は予算外へ正しく落ちる。

```
boardAt = departureAt + （その区間までの実累積分）
ep = _fetchTrainEndpoints(乗車座標, 降車座標, boardAt)   // 駅名＋実 dep/arr を返す
→ ep.dep を depTime に、ep.arr を arrTime に、ride=arr-dep を minutes に当てる
```

- `RouteSegment.copyWith` に `minutes`/`depTime`/`arrTime` を追加。
- `_fetchTrainEndpoints` を「駅名＋実発着時刻」を返す形へ拡張（駅名復元 `_finalizeStationNames` と共有）。

### 3.1 適用箇所（3 段階で塞いだ）

| commit | 箇所 | 内容 |
|---|---|---|
| `2939d01` | 予算内選定ループ | 採用候補の時刻なし電車に実時刻を当て、予算超過なら除外して次善へ |
| `cf95882` | best-effort 縮退 | 縮退候補にも実時刻を当ててから「今夜乗れる範囲の実到着最早」を選ぶ |
| `2f66959` | **ep-null の穴** | 引き直しても便を確認できない時刻なし電車を含む候補を除外（下記） |

### 3.2 ep-null の穴（最後の穴・`2f66959`）

`2939d01`/`cf95882` は「**実発車時刻を取得できたとき**」しか塞げていなかった。深夜はコリドー座標から短い区間を引き直すと、**API が all-walk だけ返して電車便を 0 件にする**ことがある（実機の都立大学→学芸大学 森91 01:08）。すると：

1. `_fetchTrainEndpoints` が `null` を返す
2. ハイブリッド電車区間は `depTime == null` のまま残る
3. `maxBoardingWait == 0` で「今夜乗れる」判定を素通り → 幻便が提示される

対策: **引き直しても実発車時刻を確認できなかった時刻なし電車（＝その時間に便が無い疑い）を含む候補は、best-effort・予算内確定の双方で除外する。** 電車を含まない全徒歩は常に残るため、幻便の代わりに全徒歩（または実時刻を確認できた本物の便のみ）へ縮退する。best-effort 縮退処理は `_bestEffortResolved` に共通化し両経路から呼ぶ。

## 4. 不変条件（恒久）

> **時刻なし（`depTime == null`）の電車区間は、実 `/guidance/plan` 引き直しで実発車時刻を確認できない限り、最終ルートに含めない。** 確認できた区間は実発着時刻で乗車待ち・乗車時間を計算する。深夜・終電後はこの検証で「走っていない便」が予算判定（予算内確定・best-effort の双方）を素通りするのを防ぐ。

標準乗換は初回 `/guidance/plan` 解析時に `depTime` を持つので検証不要（確認済み）。乗車駅探索（board-search）の引き直し便も実時刻を持つ（自己整合）。検証が要るのは**コリドー座標から合成したハイブリッド**だけ。

## 5. テスト

`test/core/services/transit_route_service_test.dart` の group「時刻なしハイブリッドの実発車時刻検証」：

- 深夜のハイブリッドに始発時刻が当たり乗車待ちが到着へ入る。
- 予算外 best-effort で始発前の幻便を提示しない。
- 引き直しで便を確認できない（all-walk のみ）時刻なし電車を best-effort に出さない。
- 予算内に見えても便を確認できない時刻なし電車を確定しない。

> モック設計の注意: 全クエリで固定便を返すモックでは深夜バグを再現できず緑になって見逃す。**照会時刻に応じて始発に張り付く／コリドー点からは all-walk を返す**など、honest な実 API 挙動を模す必要がある。
