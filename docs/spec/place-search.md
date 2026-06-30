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

→ 全面切替は不可。**Autocomplete を主の typeahead、Text Search を「近くの店」専用パスとして併設するハイブリッド**にする。

## 2. 系統の使い分け

- **既定（typeahead）:** `PlacesService.autocomplete`。`placesProxy?action=autocomplete`。現在地があれば `locationBias`（円・半径50km）で近隣を上位へ寄せる。確定時に `action=details` で座標を引く2段フロー。
- **近くの店モード:** `PlacesService.nearbySearch`。`placesProxy?action=textsearch`。`places:searchText` を `rankPreference=DISTANCE` + `locationBias`（円）で叩く。座標を同梱（`PlacePrediction.latLng`）するため**確定時の `details` は不要**。

## 3. 発火方式（UI）

- 検索バー下の **「近くの店」トグル**（`ValueKey('nearby-toggle')`）。**現在地が分かるときだけ表示**する（DISTANCE は中心点が必須のため）。
- トグル ON → `PlacesNotifier.setNearby(true)` が現クエリで即再検索。
- nearby ON でも**現在地が無ければ `autocomplete` へフォールバック**する（`_fetch` 内で判定）。

## 4. コスト対策

Text Search は割高 SKU。次で課金を抑制する。

- debounce 400ms（既存）。
- **最小文字数 2**（`PlacesNotifier._nearbyMinChars`）。未満は上流を呼ばず空結果。
- トグル ON のときだけ Text Search を呼ぶ（既定は Autocomplete）。

## 5. 不変条件

- API キーはクライアントに出さない（`placesProxy` + App Check）。`textsearch` も `verifyAppCheck` とレート制限を通る。
- `textsearch` は現在地（`lat`/`lon`）が無ければ上流を呼ばず 400。
- Text Search 由来の候補は座標を同梱し、確定時に追加の `details` を呼ばない。
- オフライン/失敗時もクラッシュしない（`PlacesException` を error 状態へ、座標が取れない候補は確定させず再選択を促す）。
