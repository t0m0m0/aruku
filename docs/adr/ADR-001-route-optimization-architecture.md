# ADR-001: ルート最適化アーキテクチャ比較・方式決定

- **ステータス:** 決定済み
- **日付:** 2026-05-16
- **関連 Issue:** #6（調査）, #7（RouteService定義）, #8（最適化ロジック実装）

---

## 背景

「時間内で最大限歩く」ルート最適化の実装方式が未定。以下を比較し、#7〜#10 の実装前提として方式を確定する。

- **方式A:** クライアント完結（全 Google API を端末から直接呼び出す）
- **方式A':** ハイブリッド（地図表示はクライアント必須、Directions/Places はバックエンドプロキシ経由）
- **方式B:** フルバックエンド（全 API をサーバー経由。ただし地図表示は方式A'と同じくクライアントが必須）

---

## 前提知識：地図表示とその他 API の違い

`google_maps_flutter` はネイティブの Google Maps iOS/Android SDK を内部で使用しており、この SDK がアプリ起動時に `Info.plist` / `AndroidManifest.xml` からキーを読んで直接 Google サーバーへ地図タイルを取得する。**この通信はアプリコードで制御できないため、地図を表示する限りAPIキーをアプリから完全に排除することは不可能。**

一方、Directions API・Places API は REST API であり、呼び出し元はバックエンドプロキシに変更可能。

---

## 評価軸と比較

| 評価軸 | 方式A: クライアント完結 | **方式A'（採用）: ハイブリッド** | 方式B: フルバックエンド |
|---|---|---|---|
| **APIキー秘匿** | × 全キーがアプリ内に存在。APKデコンパイルで抽出可能 | ◎ 地図用キーのみアプリ内（Maps SDK 制限で地図タイル取得のみに使用を限定可能）。Directions/Places キーはサーバー側のみ | ◎ 方式A'と同等（地図用キーはアプリに必須） |
| **HTTP リファラ制限** | — モバイルには使えない（Web専用） | — 同左 | — 同左 |
| **レート制限** | △ 端末からの直接呼び出しでクォータ管理困難 | ◎ Directions/Places はサーバー側でキャッシュ・バッチ制御可能 | ◎ 同左 |
| **インフラコスト** | ◎ ゼロ | △ プロキシサーバー分が発生（Firebase Functions 等の従量課金で最小化可能） | △ 方式A'と同等 |
| **実装コスト** | ◎ Flutter のみ | △ プロキシの実装・デプロイが追加で必要 | △ 方式A'と同等 |
| **#19（クラウド同期）との整合** | ◎ Firebase で独立追加可能 | ◎ Firebase Functions をプロキシに使えば #19 のインフラと共用可能 | ◎ 同左 |
| **テスタビリティ** | ◎ `RouteService` 抽象でモック可能 | ◎ 同左 | ○ サーバー側テストも必要 |

---

## 最適化アルゴリズムの実現方法（方式A'）

「時間内で最大限歩く」は、バックエンドプロキシ経由で Directions API を呼びつつ、**最適化ロジック自体は端末側 Dart で実行**する：

1. **徒歩ルートを取得**（プロキシ経由で Directions API `mode=walking`）→ 総所要時間・徒歩距離を確認
2. **予算内か判定**
   - 予算内 → 徒歩オンリーで walkRatio = 1.0 として採用
   - 予算超過 → 電車区間の候補をプロキシ経由で Directions API `mode=transit` で取得
3. **ハイブリッドルート最適化**（端末側で実行）
   - 候補ごとに `totalMin ≤ budgetMin` を満たしつつ **`walkMinutes`（徒歩時間）が最大** となるものを選択（実装 `selectBestRoute` と一致。当初 `walkKm` と記したが、運動時間の最大化として徒歩「分」を正とする。詳細は [ルート最適化 仕様（正本）](../spec/route-optimization.md) §1）
4. **指標算出**（walkRatio, kcal, segments, timelineNodes）を Dart で計算

API コール数は1ルート探索あたり最大2〜5回程度。

---

## 決定

**方式A'（ハイブリッド）を採用する。Google 推奨の構成。**

### 理由

1. **Google 推奨:** Directions API・Places API のバックエンドプロキシ経由は Google 公式のベストプラクティス
2. **実現可能な最大限のキー秘匿:** 地図表示用キーはアプリに必須だが、API 制限で「Maps SDK のみ」に限定できる。Directions/Places キーはアプリから完全排除
3. **インフラは最小化可能:** **Firebase Functions**（従量課金）を使えば、#19 のクラウド同期インフラと共用でき、固定費ゼロ
4. **`RouteService` 抽象と整合:** #7 の設計意図通り、実装を差し替えるだけで対応可能

### Google Cloud Console でのキー設定

| キー | API制限 | アプリ制限 | 置き場所 |
|---|---|---|---|
| 地図表示用 | Maps SDK for iOS / Maps SDK for Android のみ | バンドルID / パッケージ名+SHA-1 | `Info.plist` / `AndroidManifest.xml` |
| Directions/Places 用 | Directions API / Places API のみ | サーバーIPアドレス | バックエンド環境変数のみ |

---

## 影響する後続 Issue

| Issue | 影響 |
|---|---|
| #7 RouteService 定義 | `RouteService` がバックエンドプロキシを呼ぶ前提で実装。プロキシのエンドポイント設計も含む |
| #8 最適化ロジック実装 | Directions API 呼び出しはプロキシ経由。最適化アルゴリズム自体は端末側 Dart で実装 |
| #9 ローディング画面連動 | プロキシ応答＋端末計算完了を Riverpod で検知してUI遷移 |
| #10 エラーハンドリング | プロキシエラー・タイムアウト・圏外を端末側で捕捉 |
| #19 クラウド同期 | Firebase Functions をプロキシと共用することでインフラを統一可能 |

## 採用技術

**バックエンドプロキシ: Firebase Functions（TypeScript）**

- #19（クラウド同期）で導入予定の Firebase プロジェクトと共用
- 従量課金で固定費ゼロ（無料枠: 200万呼び出し/月）
- Flutter との親和性が高い

## 新規追加が必要な作業

- Firebase プロジェクト初期化・Functions のセットアップ
- Directions API / Places API プロキシ関数の実装
- Google Cloud Console でのキー分離設定（地図用・プロキシ用を別キーに）
- `places_service.dart` の呼び出し先をプロキシに変更（現状はクライアントから直接 Places API を叩いている）
