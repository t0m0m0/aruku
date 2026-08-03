# ADR-001: ルート最適化アーキテクチャ比較・方式決定

- **ステータス:** **Superseded**（2026-08-03・#339）
- **日付:** 2026-05-16
- **関連 Issue:** #6（調査）, #7（RouteService定義）, #8（最適化ロジック実装）
- **後継:** [ルート最適化 仕様（正本）](../spec/route-optimization.md) / [地点検索 仕様（正本）](../spec/place-search.md)

---

> **本書は 2026-05-16 時点の決定記録であり、現行構成の説明ではない。**
> 採用した骨格（**地図はクライアント／外部 REST API はプロキシ経由／最適化ロジックは端末側 Dart**）は今も有効だが、
> **どの API をどこから叩くか**は以降の実装で変わった。API 構成・アルゴリズムを知りたい場合は上記の正本を読むこと。
> 本書に残る Directions API 前提の記述は、当時の比較検討の材料としてのみ読む。

### 現行構成（2026-08-03 時点・詳細は正本）

| 用途 | 現行 | 本 ADR 当時の想定 |
|---|---|---|
| 公共交通経路 | **Transit API** `/api/v1/guidance/plan` を**クライアントから直叩き**（プロキシを通らない） | Directions API `mode=transit` をプロキシ経由 |
| 徒歩の所要・距離・街路ジオメトリ | **Google Routes API** `computeRoutes` / `computeRouteMatrix`(WALK) を `googleWalkProxy` / `googleWalkMatrixProxy` 経由 | Directions API `mode=walking` をプロキシ経由 |
| 地点検索 | **Google Places API (New)** を `placesProxy` 経由 | Places API（当時はクライアント直叩き。プロキシ化が宿題だった） |
| 最適化 | 端末側 Dart の **measure-first**（推定で shortlist → Google 徒歩実測で確定）。目的関数は**予算内で徒歩時間 `walkMinutes` 最大**、予算内候補が無ければ**実到着が最早**の候補へ縮退（best-effort） | 端末側 Dart で `totalMin ≤ budgetMin` を満たす候補から選択 |
| 公開 HTTP 関数 | `placesProxy` / `googleWalkProxy` / `googleWalkMatrixProxy` の3つ | Directions / Places プロキシ |

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

> **この節は当時の想定であり、現行アルゴリズムではない。** 現行は measure-first（推定で shortlist を作り、
> Google 徒歩実測を経て確定）で、公共交通は Transit API の `/guidance/plan` を1回引いた結果を母集合にする。
> 実際のフロー・不変条件は [route-optimization.md](../spec/route-optimization.md) §3 が正本。

「時間内で最大限歩く」は、バックエンドプロキシ経由で Directions API を呼びつつ、**最適化ロジック自体は端末側 Dart で実行**する：

1. **徒歩ルートを取得**（プロキシ経由で Directions API `mode=walking`）→ 総所要時間・徒歩距離を確認
2. **予算内か判定**
   - 予算内 → 徒歩オンリーで walkRatio = 1.0 として採用
   - 予算超過 → 電車区間の候補をプロキシ経由で Directions API `mode=transit` で取得
3. **ハイブリッドルート最適化**（端末側で実行）
   - 候補ごとに `totalMin ≤ budgetMin` を満たしつつ **`walkMinutes`（徒歩時間）が最大** となるものを選択（実装 `selectBestRoute` と一致。当初 `walkKm` と記したが、運動時間の最大化として徒歩「分」を正とする。詳細は [ルート最適化 仕様（正本）](../spec/route-optimization.md) §1）
4. **指標算出**（walkRatio, kcal, segments, timelineNodes）を Dart で計算

API コール数は1ルート探索あたり最大2〜5回程度（当時の見積り。measure-first では徒歩実測のファンアウトが加わり
この規模には収まらない。現行の往復本数は [route-optimization.md](../spec/route-optimization.md) §3.8 の実測が正本）。

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
| プロキシ用 | Directions API / Places API のみ（**現行は Routes API / Places API (New)**） | サーバーIPアドレス（**現行は掛けられない**・下記） | バックエンド環境変数のみ（**現行は Secret Manager の `GOOGLE_MAPS_API_KEY`**） |

> **「サーバーIPアドレス」制限は現行構成では実施できない。** プロキシは 2nd gen Cloud Functions（Cloud Run）で、
> VPC 下り + Cloud NAT を構成しない限り下り IP が固定されない。この表のとおりに IP 許可リストを設定すると
> Places / Routes の呼び出しが落ちる。現行のプロキシ用キーはアプリケーション制限を持たず、API 制限と
> App Check・レート制限・Secret Manager で守る。

キー分離の現行手順は [security_hardening.md](../security_hardening.md) ① が正本。

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

## 新規追加が必要な作業（当時）

> これは 2026-05-16 時点の宿題リストであり、**このリストが現在の残作業を表しているわけではない**。
> 現在の到達点を右欄に付す。**運用作業の進捗の正本は本書ではなく
> [security_hardening.md](../security_hardening.md) のチェックリスト**なので、本番前の可否判断はそちらで行う。

| 当時の作業 | 現在 |
|---|---|
| Firebase プロジェクト初期化・Functions のセットアップ | 完了（`functions/`・`asia-northeast1`） |
| Directions API / Places API プロキシ関数の実装 | 完了。ただし実装されたのは `placesProxy` と Google **Routes** の `googleWalkProxy` / `googleWalkMatrixProxy`。公共交通は Directions ではなく Transit API のクライアント直叩きになった |
| Google Cloud Console でのキー分離設定（地図用・プロキシ用を別キーに） | **未完了。** プロキシ側へのキー隔離（アプリから Google の REST API を呼ばない）は済んでいるが、Console でのキー制限（アプリ制限・API 制限）は手動作業で**未実施**。状態の正本は [security_hardening.md](../security_hardening.md) ① のチェックリスト |
| `places_service.dart` の呼び出し先をプロキシに変更 | 完了（#144。`placesProxy` + App Check 経由） |
