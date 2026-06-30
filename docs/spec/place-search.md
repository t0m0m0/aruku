# 地点検索 仕様（二系統）

- **位置づけ:** 目的地・出発地の地点検索の **設計の正本**。検索系統を変える実装・レビューは本書を基準にする。
- **最終更新:** 2026-06-30
- **対象コード:** `lib/core/services/places_service.dart`, `lib/features/search/places_provider.dart`, `lib/features/search/search_screen.dart`, `functions/src/index.ts`（`placesProxy`）, `functions/src/places-transform.ts`
- **関連:** #144（POI を Google へ戻す）, #145（その実装）, #146（近くの店モード併設）

---

## 1. なぜ二系統か

地点検索には用途の異なる 2 つの要求があり、**単一の Google API では両立しない**（#146 実測）。

| 要求 | 例 | 最適な API |
|---|---|---|
| 駅・住所・地名の typeahead | 下北沢駅 / 渋谷 / 丸の内1-1 | **Autocomplete (New)** |
| 「近くの店」を距離昇順で | マクドナルド / コンビニ | **Text Search (New) + `rankPreference=DISTANCE`** |

- **Autocomplete** は駅・地名候補に強いが、`locationBias` は**ソフトな地域バイアス**で距離ソートではない。近隣には寄るが「近い順」にはならない。座標を返さないため確定時に `details`（`fetchLatLng`）が必要。
- **Text Search + DISTANCE** は現在地から**厳密に距離昇順**で返し座標も同梱するが、**駅・地名の typeahead を壊す**（下北沢駅で1件、渋谷で無関係 POI 羅列）。

→ 全面切替は不可。本ブランチは **C案: Autocomplete のまま、`origin` で得た距離をクライアントで距離昇順に再ソート**する方式を採る（Text Search 併設の別案は #147 / `feat/146-textsearch-distance-nearby` で比較中）。

## 2. 系統の使い分け（C案）

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

## 6. 別案との比較（#147 Text Search）

| 観点 | C案（本ブランチ） | Text Search案（#147） |
|---|---|---|
| 近い順 | 関連度で出た候補を距離再ソート（≒5件） | 厳密な距離昇順（最大20件） |
| typeahead | 壊さない（Autocomplete のまま） | 壊さない（別パス併設） |
| 課金 | 追加なし（Autocomplete のみ） | 割高 SKU を都度消費 |
| 確定時 details | 必要（座標非同梱） | 不要（座標同梱） |
| 周辺網羅性 | 関連度が拾った範囲に限る | 周辺を広く距離順で拾う |
