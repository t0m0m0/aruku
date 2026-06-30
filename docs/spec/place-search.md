# 地点検索 仕様（Autocomplete + 距離再ソート）

- **位置づけ:** 目的地・出発地の地点検索の **設計の正本**。検索系統を変える実装・レビューは本書を基準にする。
- **最終更新:** 2026-06-30
- **対象コード:** `lib/core/services/places_service.dart`, `lib/features/search/places_provider.dart`, `lib/features/search/search_screen.dart`, `functions/src/index.ts`（`placesProxy`）, `functions/src/places-transform.ts`
- **関連:** #144（POI を Google へ戻す）, #145（その実装）, #146（近くの店モード）

---

## 1. 設計の前提

地点検索には用途の異なる 2 つの要求がある（#146 実測）。

| 要求 | 例 | 並びの正解 |
|---|---|---|
| 駅・住所・地名の typeahead | 下北沢駅 / 渋谷 / 丸の内1-1 | **関連度順** |
| 「近くの店」を距離昇順で | マクドナルド / コンビニ | **距離昇順** |

- **Autocomplete (New)** は駅・地名候補に強いが、`locationBias` は**ソフトな地域バイアス**で距離ソートではない。近隣には寄るが「近い順」にはならない。座標を返さないため確定時に `details`（`fetchLatLng`）が必要。
- ただし Autocomplete に **`origin` を渡すと各候補に距離（`distanceMeters`）が付く**。これを使えば、**系統は Autocomplete のまま**でクライアント側で距離昇順に並べ替えられる。
- Text Search(New)+DISTANCE で厳密な距離昇順も取れるが、駅・地名 typeahead を壊し（下北沢駅で1件、渋谷で無関係 POI 羅列）、割高 SKU で確定が速い等の別トレードオフがある。本実装では採用せず、より軽量な distance 再ソート方式を採る（検討記録は #146 / #147 のコメント参照）。

→ 方針: **Autocomplete を唯一の系統とし、「近くの店」モードのときだけ `distanceMeters` で並びを距離昇順に再ソートする。**

## 2. 系統の使い分け

検索は**常に `PlacesService.autocomplete`**（`placesProxy?action=autocomplete`）。系統を切り替えず、**並び順だけ**を変える。

- **proxy:** 現在地があれば `locationBias`（円・半径50km）で近隣を上位へ寄せ、同じ現在地を **`origin`** としても渡す。これで各候補に **`distanceMeters`**（origin からの測地線距離）が付く。
- **既定（typeahead）:** Autocomplete の関連度順のまま表示。駅・住所・地名に強い。
- **近くの店モード:** Autocomplete 結果を **`distanceMeters` 昇順へクライアント再ソート**（`PlacesNotifier._sortByDistance`）。距離不明の候補は元の関連度順のまま末尾へ。
- **確定:** Autocomplete は座標を返さないため、いずれのモードでも確定時に `action=details` で座標を引く2段フロー。

## 3. 発火方式（UI）

- 検索バー下の **「近くの店」トグル**（`ValueKey('nearby-toggle')`）。**現在地が分かるときだけ表示**する（距離が取れないと再ソートできないため）。
- トグル ON → `PlacesNotifier.setNearby(true)` が現クエリで即再検索。
- nearby ON でも**現在地が無ければ再ソートせず**関連度順のまま（`_fetch` 内で判定）。

## 4. コスト

C案は Text Search の割高 SKU を使わず、**通常 typeahead と同じ Autocomplete のみ**。近くの店モードでも追加課金は無し（再ソートはクライアント処理）。

- debounce 400ms（既存）。
- 最小文字数ガードは不要（Autocomplete は安価なため撤去）。

## 5. 不変条件

- API キーはクライアントに出さない（`placesProxy` + App Check）。
- `origin` は `lat`/`lon` が揃うときだけ送る（欠落時は付けない）。距離が無い候補は再ソートで末尾。
- オフライン/失敗時もクラッシュしない（`PlacesException` を error 状態へ、座標が取れない候補は確定させず再選択を促す）。

## 6. 既知の限界

- 近くの店モードが並べ替えるのは**Autocomplete が関連度で拾った候補（≒5件）**で、選抜自体は関連度任せ。関連度が拾わなかった近所の小さな店は出てこない。周辺を広く距離順で網羅したい要件が出たら Text Search(New)+DISTANCE の併設を再検討する（#147 に実装案あり）。
