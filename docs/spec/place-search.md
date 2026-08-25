# 地点検索 仕様（Autocomplete + 距離再ソート）

- **位置づけ:** 目的地・出発地の地点検索の **設計の正本**。検索系統を変える実装・レビューは本書を基準にする。
- **対象コード:** `lib/core/services/places_service.dart`, `lib/features/search/places_provider.dart`, `lib/features/search/search_screen.dart`, `functions/src/index.ts`（`placesProxy`）, `functions/src/places-transform.ts`
- **関連:** [route-optimization.md](route-optimization.md) §2.1（`placesProxy` の構成）

---

## 1. 設計の前提

地点検索には用途の異なる 2 つの要求がある（#146 実測）。

| 要求 | 例 | 並びの正解 |
|---|---|---|
| 駅・住所・地名の typeahead | 下北沢駅 / 渋谷 / 丸の内1-1 | **関連度順** |
| 「近くの店」を距離昇順で | マクドナルド / コンビニ | **距離昇順** |

- **Autocomplete (New)** は駅・地名候補に強いが、`locationBias` は**ソフトな地域バイアス**で距離ソートではない。近隣には寄るが「近い順」にはならない。座標を返さないため確定時に `details`（`fetchLatLng`）が必要。
- ただし Autocomplete に **`origin` を渡すと各候補に距離（`distanceMeters`）が付く**。これを使えば、**系統は Autocomplete のまま**でクライアント側で距離昇順に並べ替えられる。
- **Text Search(New)+DISTANCE へ全面切替してはならない。** 厳密な距離昇順は得られるが、駅・地名の typeahead を壊す（実測: 「下北沢駅」で1件、「渋谷」で無関係な POI が並ぶ・#146）。加えて SKU が割高。

→ 方針: **Autocomplete を唯一の系統とし、「近くの店」モードのときだけ `distanceMeters` で並びを距離昇順に再ソートする。**

## 2. 系統の使い分け

検索は**常に `PlacesService.autocomplete`**（`placesProxy?action=autocomplete`）。系統を切り替えず、**並び順だけ**を変える。

- **proxy:** 現在地があれば `locationBias`（円・半径50km）で近隣を上位へ寄せ、同じ現在地を **`origin`** としても渡す。これで各候補に **`distanceMeters`**（origin からの測地線距離）が付く。
- **既定（typeahead）:** Autocomplete の関連度順のまま表示。駅・住所・地名に強い。
- **近くの店モード:** Autocomplete 結果を **`distanceMeters` 昇順へクライアント再ソート**（`PlacesNotifier._sortByDistance`）。距離不明の候補は元の関連度順のまま末尾へ。
- **確定:** Autocomplete は座標を返さないため、いずれのモードでも確定時に `action=details` で座標を引く2段フロー。

## 3. 発火方式（UI）

- 検索バー下の **「近くの店」トグル**（`ValueKey('nearby-toggle')`）。**現在地が分かるときだけ表示**する（距離が取れないと再ソートできないため）。
- トグル切替 → `PlacesNotifier.setNearby(value)` が**取得済みの候補をその場で距離順へ再ソート**する。**追加の API リクエストは発行しない**（課金と debounce 400ms の待ちが要らない・§4）。関連度順の生結果は `_rawSuggestions` に保持し、OFF へ戻すと元の並びへ復帰する。
- 再ソートできるのは、**その候補を取得した時点で現在地が分かっていた**場合に限る。`origin` は取得時に送るため、距離は取得時に確定して候補へ焼き付く（後から付かない）。現在地の到着が取得より遅れた場合は §6 を参照。
- まだ結果が無い／取得中の切替はフラグだけ更新し、進行中の取得が完了した時点で正しい並びで反映する。
- nearby ON でも**現在地が無ければ再ソートせず**関連度順のまま（`_arrange` 内で判定）。

## 4. コスト

Text Search の割高 SKU を使わず、**通常 typeahead と同じ Autocomplete のみ**。近くの店モードでも追加課金は無い（再ソートはクライアント処理）。

- debounce 400ms。
- 最小文字数ガードは無い（Autocomplete が安価なため不要）。

## 5. 不変条件

- API キーはクライアントに出さない（`placesProxy` + App Check）。
- `origin` は `lat`/`lon` が揃うときだけ送る（欠落時は付けない）。距離が無い候補は再ソートで末尾。
- オフライン/失敗時もクラッシュしない（`PlacesException` を error 状態へ、座標が取れない候補は確定させず再選択を促す）。

## 6. 既知の限界

- 近くの店モードが並べ替えるのは**Autocomplete が関連度で拾った候補（≒5件）**で、選抜自体は関連度任せ。関連度が拾わなかった近所の小さな店は出てこない。周辺を広く距離順で網羅する要件が出た場合は、全面切替ではなく Text Search(New)+DISTANCE の**併設**で対応する（切替が不可な理由は §1）。
- **現在地の到着が取得より遅れると、トグルが効かない候補が残る。** 取得時に現在地が未確定だと `origin` を送れず、その候補には `distanceMeters` が付かない。その後に現在地が届くとトグルは表示されるが（表示条件は現在地の有無）、`setNearby` は再フェッチしないため `_sortByDistance` は距離不明の候補を末尾へ回すだけで**並びが変わらない**。トグルを押しても無反応に見える。次のクエリ入力で取得し直せば解消する。恒久対策（現在地到着時の再取得、または座標確定後の距離再計算）は未実装。
