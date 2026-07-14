# Transit API 徒歩閾値パラメータの実測調査（#288）

- **ステータス:** 調査完了（実装なし）。結論＝**徒歩閾値パラメータは存在しない**。次アクションは §6。
- **Issue:** #288（徒歩閾値バリエーション照会で候補の路線多様性を確保できるか）。
- **手法:** `avoidModes` 発見時（#245/#247）と同じ実 API 差分法。使い捨ての curl probe をレスポンス差分で判定。
- **調査日:** 2026-07-14。API: `https://api.transit.ls8h.com/api/v1/guidance/plan`（認証不要）。
- **関連:** [optimization-backend-offload.md](optimization-backend-offload.md) 限界2, [transit-api-migration.md](transit-api-migration.md), `project_transit_api_avoid_modes`, `reference_more_walking_paper`。

---

## 0. 背景と仮説

先行研究（More Walking, BMC 2025）は OpenTripPlanner に対し**徒歩距離閾値を 100m〜2,500m の6段階**で振って同一 OD を複数回照会し、閾値ごとに**異なる路線ファミリ**の非劣解を得ている。#288 の仮説は「Transit API `/guidance/plan` にも徒歩閾値系の（ドキュメント外）パラメータがあり、それを振れば単一 base アンカー（限界2）を崩して路線多様性を安価に得られるのでは」。

---

## 1. 判定方法（沈黙無視の検出）

`/guidance/plan` は**未知のクエリパラメータを HTTP 200 で受理して黙って無視する**。そのため「パラメータを付けて 200 が返った」だけでは効き目を判定できない。各 option を **`(路線ファミリ, walkSecs, transferCount, durationSecs)`** に要約し、option 集合のフィンガープリントで比較した。判定の妥当性は2つの対照で担保:

- **負の対照（デタラメ param）** `__nonsense_ctrl__=9999` … 効かないはず → baseline と一致すれば「沈黙無視」を確認。
- **正の対照（既知の効くパラメータ）** `avoidModes` を動かす … 効くはず → フィンガープリントが変われば「検出器が本物の差を捉える」ことを確認。

正の対照は **CHANGED（検出器 OK）** を示した（§3）。よって「同一」判定は盲点ではなく信頼できる null である。

---

## 2. 結論①：徒歩閾値パラメータは存在しない

OD＝六本木ヒルズ→駒沢公園、2026-07-16 10:00、`avoidModes=bus,ferry,air`、baseline は 7 option（路線ファミリ2種: `DT`のみ 徒歩74分/0乗換、`日比谷線/TY/DT` 徒歩40分/2乗換 ＋ 全徒歩125分）。

**投げた候補パラメータ名 全22種すべてが baseline と完全一致（＝デタラメ param と同じ挙動）:**

| 分類 | 試した名前（値） | 結果 |
|---|---|---|
| camelCase | `maxWalkDistance`(3000/300) `walkDistance`(3000) `maxWalkTime`(3600) `maxWalkSecs`(3600) `walkSpeed`(0.5) `walkReluctance`(0.1) `maxWalkingDistance`(3000) `walkBoardCost`(0) `maxWalk`(3000) `maxWalkDistanceMeters`(3000) `walkCost`(10) `maxTransferDistance`(3000) | 全て same-as-base |
| snake_case | `max_walk_distance` `walk_distance` `max_walk_time` `walk_speed` | 全て same-as-base |
| 意図系 | `preferWalk=true` `maximizeWalk=true` `walkPreference=high` `walkingSpeed=0.5` `mode=walk_max` | 全て same-as-base |
| 負の対照 | `__nonsense_ctrl__=9999` | same-as-base |

`maxWalkDistance=300`（徒歩を強く絞る値）でも徒歩74分の option・全徒歩125分の option がそのまま残った。もし閾値が効くなら真っ先に消えるはずの候補が不変＝**効いていない**。

**MCP スキーマ（`plan_journey`＝同 API のミラー）とも整合**: パラメータは `from/to/date/time/type/via/allowModes/avoidModes/avoidWalk/maxTransfers/numItineraries` のみで、徒歩閾値系は定義されていない。

### 2.1 補強: mode 値は検証されるが未知 param 名は無視される

`allowModes=train,subway`（`train` は無効な mode 名）は **HTTP 400**。一方、未知の**パラメータ名**は 200 で無視。この非対称は「mode フィルタは実在の検証済み機能／徒歩閾値は API サーフェスに無い」ことの傍証。

---

## 3. 結論②：パラメータ不在時の代替手段（路線多様性）

論文の効果（閾値を振ると別路線ファミリが出る）を、この API で得られる他手段で再現できるか3 OD（都心／郊外／深夜帯）で確認した。**path 差分は routeName の集合で数える（全徒歩 option は除外）。**

### (A) 出発時刻ずらし — ✗ ほぼ無効

| OD | 10:00 | +20 | +40 | 3回の路線family和集合 |
|---|---|---|---|---|
| 六本木ヒルズ→駒沢公園 | 2 | 2 | 2 | **2**（不変） |
| 吉祥寺→小平 | 1 | 1 | 1 | **1** |
| 東京駅→恵比寿(夜) | 2 | 2 | 2 | **2**（山手線 内/外のみ） |

時刻をずらしても**同じ路線で捕まえる便が変わるだけ**で、別コリドーは出ない。

### (B) `allowModes` サブネット限定 — △ 別コリドーは出るが劣化を強制

六本木ヒルズ→駒沢公園:

- `allowModes=rail` … baseline とほぼ同じ（family 2）。
- `allowModes=subway` … **別コリドーが出た**（`大江戸線/新宿線/三田線`）が、徒歩81分・所要115分と、rail 系（40分/57分）より**大幅に遅い**。「同程度の所要で徒歩を増やす」ではなく「別ネットワークで大回り」。
- `avoidModes` を緩めてバス許容 … family は激変するが徒歩が**減る**方向（都01バスで18分）＝#288 の目的と逆。

### (C) `maxTransfers` 掃引 — △ 軽微

`0/1` で family 1、`3/5` で family 2（2乗換の `日比谷線/TY/DT` が解禁）。ただしアプリは既定 3 を使用済みで、ここから増やしても追加の family は出なかった。

### (D) `avoidWalk` — API 唯一の walk 系ノブ（二値）

スキーマ上は `avoidWalk=true`（徒歩を含む option を除外）が存在。**段階的な閾値ではなく二値**で、#288 が欲しい「徒歩を増やす」方向でもない（geo↔geo では徒歩ゼロ経路が組めず実照会はタイムアウト）。API の walk 系サーフェスはこの二値のみ。

---

## 4. 重要な再フレーム：ボトルネックは API でなくクライアント

baseline（rail-only）は **すでに高徒歩コリドーを返している**——`DT` のみ**徒歩74分/0乗換**の option と、`日比谷線/TY/DT` **徒歩40分/2乗換**の option が同一レスポンスに共存する。つまり「徒歩多め候補」の素材は単一照会に部分的に既に入っている。

限界2（単一最速 base アンカー）は **API の制約ではなくクライアント側 `_baseForHybrid`（総所要 `minutes` 最小の1本だけを base にする）の選択**。徒歩を増やすバリエーションが候補プールに入らないのは、閾値パラメータが無いからではなく、アプリが最速1本しか base にしないから。

---

## 5. 受け入れ条件への回答

- [x] 徒歩閾値系パラメータの有無が実測で確定 → **存在しない**（§2、22名前×差分＋正負両対照）。
- [x] （存在時のサンプル）→ 該当なし（存在しないため）。代わりに代替手段の差分を §3 に記録。
- [x] `docs/notes/` に記録（本書）。
- [x] 実装可否・次ステップ・増分コスト → §6。

---

## 6. 実装可否と推奨する次のステップ

**#288 の当初案（閾値バリエーション照会）は不採用**。この API に閾値ノブは無く、時刻ずらしは無効、サブネット限定は「別コリドーだが大幅劣化」を強制するため、論文の「同程度の所要で路線ファミリを増やす」効果は query だけでは再現できない。

**推奨（限界2への安価な前進、API 非依存）:**

1. **`_baseForHybrid` を最速1本から上位N本へ広げる**（offload note の「最小改善案」）。baseline が既に返す高徒歩コリドー（例: `DT`単独74分）を base 候補に含めれば、別路線に沿って徒歩を増やすハイブリッドが候補プールに入る。**増分 API コストゼロ**（既存の単一 `/guidance/plan` レスポンスの option を追加で使うだけ）。
2. 1 で不足なら、**`allowModes` サブネット限定を「追加コリドー源」として1回だけ併用**する案を別途検討（増分コスト＝transit 照会 +1/検索）。ただし §3(B) の通り劣化コリドーを掴みやすく、予算内フィルタで多くが落ちる見込み。費用対効果は 1 を実装してから測る。

**増分コスト見積り:** 案1＝ゼロ（クライアント内の候補生成のみ）。案2＝`/guidance/plan` +1回/検索（レイテンシ 9〜11 秒 × 1、Google 実測系は既存フロー再利用）。

**次 issue の切り出し方針:** 「`_baseForHybrid` を top-N base へ拡張（#288 派生・API 非依存のクライアント改修）」を新規 issue として起票し、限界2の実測改善を TDD で行う。
