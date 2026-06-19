# 乗り遅れ再照会の再アンカー化＋別路線許容（実装案）

- **ステータス:** 設計（実装前）。本書は実装の指針。確定したら [route-optimization.md](../spec/route-optimization.md) §4 #115 と §5 を更新する。
- **対象:** `lib/core/services/navitime_route_service.dart` の `_refetchMissedTrain` / `_findRealBoarding` と `_selectMeasured` の選定ループ。
- **関連不変条件:** #65 / #67 / #71 / #115 / #117 / #118 / #121 / 逆戻りフィルタ。
- **ブランチ:** `fix/refetch-reanchor-line-substitution`

---

## 1. 背景（実機ログで確定した根本原因）

「制限内で徒歩最大」を選ぶ目的に対し、実機では**予算内で徒歩166分の候補があるのに徒歩120分・余裕45分**が提示される（現在地→上野公園・制限3時間）。実機 `[ROUTE-DIAG]` ログで機序を確定した：

1. ハイブリッド候補は **基準経路（最速1本）の早い時刻の時刻表を借用**する。
2. 徒歩を増やす候補＝**乗車を遅らせる候補は、その借用列車に必ず乗り遅れる**（`firstMissedTrain` が成立）。
3. `#115` の再照会 `_refetchMissedTrain` が **8候補すべてで失敗**し、片端から除外される。
4. `_maxEnrichAttempts = 8` を使い切り、**attempt=8 では検証をスキップして**歩かない候補（徒歩120分）をそのまま返す。

### 再照会が必ず失敗する理由（ログ実証）

`_findRealBoarding`（[navitime_route_service.dart:562](../../lib/core/services/navitime_route_service.dart)）は再照会レスポンスに対し
**「乗車駅名 == `boardName`」かつ「路線名 == `line`」かつ「降車駅名 == `alightName`」の厳密三重一致**を要求する。
しかし乗車駅座標から再照会すると NAVITIME は自前の最適経路を返し、実データは：

- **乗車駅が1駅ズレる**：例 `大森` から再照会 → 返ってくる最適経路は **`大井町` から乗車**（`大森` は停車駅リストに現れない）。`boardName` 不一致で全滅。
- **別路線になる**：同じ降車駅に着く代替が **`ＪＲ山手線`**（`line` が `ＪＲ京浜東北線・根岸線快速` と不一致）。

→ 欲しい列車（同一路線で目的の降車駅に停車）が item に存在しても、**乗車駅名・路線名の厳密一致でほぼ確実に弾かれる**。

---

## 2. 方針

NAVITIME の「ここからなら◯◯駅から乗れ」という回答を**正として受け入れる**：

- **A案（再アンカー）:** 再照会が返した**実際の乗車駅 B'**（元の B と違ってよい）を採用し、アクセス徒歩 `walk1` を `origin→B'` に**測り直して**候補を組み直す。**降車駅 A は維持**する（A→goal の長い徒歩＝徒歩最大化の源泉を保つため）。
- **B案（別路線許容）:** `line` の厳密一致をやめ、**同一降車駅 A に着く実在列車なら別路線（山手線等）も採用**する。

A と B を併用する。

### 非目標（このPRでやらないこと）

- 乗換をまたぐ再アンカー（複数電車の差し替え）。MVP は単一電車のハイブリッドのみ。
- フロンティア間引き（#B）の作り直し。別件。
- 全徒歩候補・標準乗換候補の挙動変更。

---

## 3. 設計詳細

### 3.1 `_findRealBoarding` のコントラクト変更

**現行**：`({DateTime dep, DateTime arr})?` を返し、`boardName`/`line` 厳密一致を要求。

**変更後**：再照会経路から「降車駅 A（`alightName`）に `notBefore` 以降の発車で到達する実在列車」を探し、**その列車が実際に乗車する駅 B' の情報込み**で返す。

```dart
({
  GeoPoint boardCoord,   // B'（再アンカー先）の座標
  String boardName,      // B' の駅名
  String? line,          // 実際の路線（別路線可）
  DateTime dep,          // B' 発
  DateTime arr,          // A 着
  List<GeoPoint> polyline, // B'→A の停車駅座標列（逆戻り判定・表示用）
})?
```

判定ロジック：
- `boardName == 元のB` の制約を**外す**。各 item の stops を走査し、**A（`alightName`）に停車し `arr` を持つ**停車駅を探す。
- その A に到達する**同一乗車区間内の最初の停車駅を B'** とする（= NAVITIME がその経路で乗る駅）。`#65` のとおり乗車駅は calling_at 先頭に出ない場合があるため、**move 直下 `from_time` で補った乗車駅も B' 候補に含める**（後述 3.4）。
- `line` 一致を**要求しない**（B案）。複数 item で A に着けるなら **A 着が最早**のものを採る（既存の「items は最早接続先頭」前提を踏襲）。
- `B'` の発車が `notBefore` 以降であること（乗車前に出る列車は不可）。

### 3.2 再アンカー（`_refetchMissedTrain` 側）

`_findRealBoarding` が `B'` 込みで返したら：

1. **walk1 を測り直す**：`origin→B'` を `_tryWalk`（街路実測・`walkCache` 利用）で取得。失敗時は `_estimateWalk`（直線）にフォールバック。
   - `origin` は candidate の最初の徒歩区間始点（＝元の `walk1` の始点）から取得する。`_refetchMissedTrain` のシグネチャに `origin` を追加する。
2. **train 区間を組み直す**：`B'→A` を実 `dep`/`arr`、`ride = arr - dep`、polyline = 返却座標列で構築。`fare` は `_proratedFare` を B'→A の鉄道距離で再按分（#71）。`line` は実路線へ。
3. **新 candidate を構築**：`[walk(origin→B'), train(B'→A), walk(A→goal)]`。`walk2 (A→goal)` は元候補のものを流用（A 不変のため再測不要）。
4. **再検証**：新 candidate に対し `firstMissedTrain` を再評価。`B'` への徒歩が実測で伸びて再び乗り遅れるなら `null` を返す（呼び出し側が除外）。`#115` の「乗れない列車を確定しない」を維持。

### 3.3 選定ループ（`_selectMeasured`）の扱い

- 既存どおり、再アンカー成功なら pool 内の該当候補を新 candidate に**差し替えて `continue`**（再選定で walk 最大判定をやり直す）。再アンカーで walk1 が変わるため、再選定で最適が入れ替わってよい。
- **副次バグ修正（attempt=8 の無検証フォールバック）:** 現状 `attempt == _maxEnrichAttempts` で乗り遅れ・enrich 検証を**素通り**して未検証ルートを返す。乗れない便を確定し得るため、**上限到達時は `chosen` をそのまま返さず best-effort 縮退**（`reachableWithinBudget` ベースの実到着最早）へ寄せる。最低限 `firstMissedTrain != null` の候補は返さない。
  - 併せて `_maxEnrichAttempts` の引き上げを検討（再アンカーが効けば DROP が減るので8でも足りる可能性が高い。実測で判断）。

### 3.4 #65 との整合（乗車駅が calling_at に出ない問題）

`_parseTransit` の `stops` は calling_at（途中駅）由来で**乗降駅を含まない**ことがある（#65）。`_findRealBoarding` が B' を取りこぼさないよう、**move 直下 `from_time`＋区間先頭 point 座標から乗車駅を補完**して stops 探索に含める。これは再照会経路のみのローカル補完で、本体の `_parseTransit` 契約は変えない。

### 3.5 逆戻り・予算の保全

- 再アンカーで B' が A より goal 寄り（B'→A が逆走）になることはない（同一区間で B'<A を保証）。
- 新 candidate は通常の選定・`selectBestRoute` の逆戻りフィルタ・予算判定を通る（差し替え後に再選定するため自動的に担保）。

---

## 4. 変更ファイル

| ファイル | 変更 |
|---|---|
| `lib/core/services/navitime_route_service.dart` | `_findRealBoarding` 戻り値拡張・制約緩和、`_refetchMissedTrain` に `origin` 追加＋再アンカー、ループの上限到達時フォールバック修正、再照会経路の乗車駅補完 |
| `docs/spec/route-optimization.md` | §4 #115 を「実在列車へ差し替え（乗車駅の再アンカー・別路線許容を含む）」へ更新、§5 の `_findRealBoarding` 契約を追記 |
| `test/core/services/navitime_route_service_test.dart` | 後述の回帰テスト追加 |

---

## 5. テスト計画（TDD・先に失敗するテストを書く）

調査で使った再現（現在地→上野公園・各停12駅・借用時刻表で全乗り遅れ）を**恒久の回帰テスト**に昇格する。

1. **再アンカー成功**：乗車駅 B から再照会すると NAVITIME が B'（1駅先）から乗る経路を返すモック。`plan()` が**徒歩最大の候補を B' へ再アンカーして返す**（採用の walkMinutes が借用時刻表時の縮退値より大きい／余裕が大幅に縮む）ことを検証。
2. **別路線許容（B案）**：同一降車駅に山手線で着く item のみ返すモックで、`_findRealBoarding` が山手線を採用することを検証。
3. **再アンカー後も乗り遅れるなら除外**：B' への徒歩が実測で伸び再び乗り遅れるケースで `null`（候補除外）になることを検証（#115 安全側）。
4. **上限到達フォールバック**：全候補が再照会不能なとき、未検証の乗り遅れルートではなく best-effort 縮退（実到着最早・乗り遅れ無し）を返すことを検証。
5. **既存不変条件の非回帰**：#65/#67/#71/#117/#118/#121 と逆戻りフィルタの既存テストが全て緑。

純粋関数 `_findRealBoarding` は `@visibleForTesting` で直接ユニットテストする（A 着最早の選択・別路線採用・notBefore 境界）。

---

## 6. リスク

- **NAVITIME 往復増**：再アンカーは採用候補1経路の検証時のみ（全候補ではない）。再照会回数は現状と同じ（差し替え成功なら DROP ループが減り、むしろ往復減の可能性）。レート制限（30/min）への影響は実測で確認。
- **walk1 再測の1コール**：採用パスのみ・`walkCache` 利用で増分は小さい。
- **A 着最早の選択**が稀に最良の徒歩配分を外す可能性：差し替え後に本体選定を再実行するため、最終的な「予算内徒歩最大」は `selectBestRoute` が担保する。
