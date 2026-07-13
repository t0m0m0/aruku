# SLO とアラート定義

- **位置づけ:** Cloud Functions バックエンド（`functions/src/`）の SLI/SLO とログベース指標・アラートポリシーの定義書。issue #268「SLOとアラートを定義する」の受け入れ基準に対応する。
- **最終更新:** 2026-07-13
- **前提コード:** `functions/src/metrics.ts`（構造化ログのログ契約）, `functions/src/index.ts`（各プロキシの呼び出し箇所）
- **関連:** [route-optimization.md](../spec/route-optimization.md) §2.1（エンドポイント一覧・レート制限値）, issue #263（レート制限再設計・IaC化は未着手）

---

## 1. 目的と対象範囲

Places / NAVITIME / Google Routes への薄いプロキシ（`placesProxy`, `navitimeProxy`, `googleWalkProxy`, `googleWalkMatrixProxy`、いずれも 2nd gen Cloud Functions・`asia-northeast1`）の可用性・レイテンシ・保護機構（App Check・レート制限）の健全性を、構造化ログから機械的に測定・アラートできる状態にする。あわせて Flutter アプリ側の Crashlytics クラッシュフリー率も対象に含める（同一 PR でアプリに導入）。

対象外: 個々のユーザー体験としての「ルートが妥当か」（これは [route-optimization.md](../spec/route-optimization.md) の責務）。ここではインフラ・上流 API の可観測性のみを扱う。

---

## 2. ログ契約（前提）

`functions/src/metrics.ts` が出す3イベント。指標定義はこの契約に厳密に従う。

| event | 発火箇所 | 主フィールド | severity |
|---|---|---|---|
| `search_request` | `fetchUpstream`（全プロキシ共通） | `endpoint`（例: `placesProxy.autocomplete`, `navitimeProxy`）, `upstream`（`places`\|`navitime`\|`routes-walk`\|`routes-matrix`）, `status`（`success`\|`failure`）, `latencyMs`, `httpStatus`（任意・タイムアウトは504）, `rateLimited`（上流429のときのみ`true`） | success→info, failure→error |
| `app_check_denied` | `verifyAppCheck` | `endpoint`, `reason`（`missing`\|`invalid`\|`replayed`） | warn |
| `rate_limit` | `checkRateLimit` 呼び出し元 | `decision`（`blocked`\|`fail-open`。`allowed`は型上のみ存在し実際には出力されない） | blocked→warn, fail-open→error |

PII: 生IP・検索クエリ・座標・駅名はログに含まれない（`metrics.ts` 冒頭コメント）。

---

## 3. SLI 定義

### 3.1 検索成功率（upstream 別）

`search_request` の `status="success"` 件数 / 全件数。

**429（上流レート制限）は分母・分子から除外する。** 理由: 429 は当方プロキシの可用性劣化ではなく上流 API 側のクォータ超過であり、原因も是正手段も異なる（レート制限の運用課題は issue #263 側）。可用性 SLI に混ぜると「うちのバグ」と「上流のクォータ」が区別できなくなる。429 発生自体は §3.4 で別途追跡する。

```
success_rate(upstream) = count(status="success")
                        / count(status IN ("success","failure") AND rateLimited != true)
```

### 3.2 レイテンシ p95（upstream 別）

`search_request` かつ `status="success"` の `latencyMs` 分布から p95。失敗リクエスト（タイムアウト含む）はレイテンシ SLI に含めない — 失敗は成功率 SLI 側で捕捉済みであり、タイムアウト由来の一律に長いレイテンシを混ぜると p95 が意味をなさなくなるため。

### 3.3 App Check 拒否率

`app_check_denied` の件数（endpoint・reason 別）。分母となる「保護前の全リクエスト数」はログに出ていない（拒否時点で該当リクエストは弾かれるだけで search_request は発火しない）ため、厳密な「率」ではなく **絶対件数のレート**（件/5分など）として扱う。恒常的に一定数出るのは正常（無効トークンの流入は起こり得る）が、急増はクライアント不具合か攻撃を示す。

### 3.4 レート制限フェイルオープン件数

`rate_limit` かつ `decision="fail-open"` の件数。フェイルオープンは「レート制限を検証できず制限をかけずに通した」状態で、保護が機能していないことを意味する — 発生自体がインシデント候補。

参考: `decision="blocked"` の件数も同じログから取得できる（正当なレート制限動作。急増は乱用 or クライアント側リトライ暴走の兆候として監視対象にはするが、SLO 対象ではない）。

### 3.5 Crashlytics クラッシュフリーユーザー率

Flutter アプリ側（Firebase Crashlytics、PII フリーのクラッシュ・非致命的エラー報告）。データソースは Cloud Logging ではなく Firebase Console / Crashlytics API。

---

## 4. SLO 目標（初期値）

**注意: 実データが無い状態での初期値。実測後にチューニングする前提の仮値。**

| SLI | 目標 | 測定窓 | 根拠・備考 |
|---|---|---|---|
| 検索成功率 — `places` | ≥ 99.5% | ローリング28日 | Google Places は成熟した高可用 API。429除外後の残差はほぼ当方バグかネットワーク |
| 検索成功率 — `navitime` | ≥ 98.0% | ローリング28日 | RapidAPI 経由の外部 API。応答不安定・タイムアウトの実績を鑑み低めに設定 |
| 検索成功率 — `routes-walk` / `routes-matrix` | ≥ 99.0% | ローリング28日 | Google Routes。matrix は要素数上限があり呼び出し頻度が低いため大数の法則が弱い点に注意 |
| p95 レイテンシ — `places` | ≤ 800ms | ローリング7日 | Autocomplete/Details は単純な転送。速いはず |
| p95 レイテンシ — `navitime` | ≤ 4000ms | ローリング7日 | 経路探索は計算量が大きく上流側が遅い。実測で再チューニング前提 |
| p95 レイテンシ — `routes-walk` | ≤ 1500ms | ローリング7日 | 単一ルート計算 |
| p95 レイテンシ — `routes-matrix` | ≤ 2500ms | ローリング7日 | 最大25要素の一括計算のため単一ルートより余裕を持たせる |
| App Check 拒否件数 | 急増検知のみ（絶対閾値は§5） | 5分 | 定常的な少数拒否は許容。急増をアラート対象とする |
| レート制限フェイルオープン | 0件 | 常時 | 発生即インシデント |
| Crashlytics クラッシュフリーユーザー率 | ≥ 99.5% | 日次 | 一般的な モバイルアプリの初期目標値 |

---

## 5. Cloud Logging ログベース指標

**リソースタイプに関する注意:** 本プロジェクトの関数は `firebase-functions/v2`（`onRequest`）＝ 2nd gen Cloud Functions で、内部的に Cloud Run 上で稼働する。Cloud Logging 上のリソースタイプは `cloud_function` ではなく **`resource.type="cloud_run_revision"`**（`resource.labels.service_name` に関数名が入る）になる点に注意（1st gen との違い）。

### 5.1 検索リクエスト件数（成功/失敗、upstream・status 別ラベル付きカウンタ）

```bash
gcloud logging metrics create search_request_count \
  --description="search_request イベントの件数（upstream/status/rate_limited 別ラベル付き）" \
  --log-filter='resource.type="cloud_run_revision"
jsonPayload.event="search_request"' \
  --label-extractors='upstream=EXTRACT(jsonPayload.upstream),status=EXTRACT(jsonPayload.status),rate_limited=EXTRACT(jsonPayload.rateLimited)'
```

成功率は Monitoring 側で `rate_limited != "true"` を除外して `status="success"` / (`status="success"` + `status="failure"`) を計算する（MQLもしくはアラートポリシーの比率条件）。

### 5.2 検索レイテンシ分布（upstream 別、成功リクエストのみ）

分布メトリクス＋ラベルは `gcloud logging metrics create --config-from-file` が必要。

```yaml
# /tmp/search_request_latency.yaml
name: search_request_latency
description: "search_request（status=success）の latencyMs 分布（upstream別）"
filter: >-
  resource.type="cloud_run_revision"
  jsonPayload.event="search_request"
  jsonPayload.status="success"
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: "ms"
  labels:
    - key: upstream
labelExtractors:
  upstream: EXTRACT(jsonPayload.upstream)
valueExtractor: EXTRACT(jsonPayload.latencyMs)
bucketOptions:
  explicitBuckets:
    bounds: [50, 100, 200, 400, 800, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 12000]
```

```bash
gcloud logging metrics create search_request_latency --config-from-file=/tmp/search_request_latency.yaml
```

### 5.3 App Check 拒否件数（endpoint・reason 別ラベル）

```bash
gcloud logging metrics create app_check_denied_count \
  --description="app_check_denied イベントの件数（endpoint/reason 別ラベル）" \
  --log-filter='resource.type="cloud_run_revision"
jsonPayload.event="app_check_denied"' \
  --label-extractors='endpoint=EXTRACT(jsonPayload.endpoint),reason=EXTRACT(jsonPayload.reason)'
```

### 5.4 レート制限判定件数（decision 別ラベル）

```bash
gcloud logging metrics create rate_limit_decision_count \
  --description="rate_limit イベントの件数（decision別ラベル。blocked/fail-openのみ、allowedは出力されない）" \
  --log-filter='resource.type="cloud_run_revision"
jsonPayload.event="rate_limit"' \
  --label-extractors='decision=EXTRACT(jsonPayload.decision)'
```

フェイルオープン専用の即時アラート用に、フィルタを絞った単独カウンタも作る（§6.1 のアラート条件をシンプルに保つため）。

```bash
gcloud logging metrics create rate_limit_fail_open_count \
  --description="rate_limit decision=fail-open の件数（保護が機能していない状態）" \
  --log-filter='resource.type="cloud_run_revision"
jsonPayload.event="rate_limit"
jsonPayload.decision="fail-open"'
```

---

## 6. アラートポリシー

通知先は未整備（Slack Webhook 等は本 issue の対象外）。まずは email 通知チャンネルを作成し、後日 Slack 連携に差し替える想定。

```bash
gcloud alpha monitoring channels create \
  --display-name="aruku-functions-alerts-email" \
  --type=email \
  --channel-labels=email_address=YOUR_ONCALL_EMAIL@example.com
```

作成した `NOTIFICATION_CHANNEL_ID` を以下のポリシーに紐付ける。

### 6.1 レート制限フェイルオープン（最優先・即時）

- **条件:** `rate_limit_fail_open_count` が 5分間で 1件以上
- **理由:** 保護機構が機能していない状態。発生自体がインシデント

```bash
gcloud alpha monitoring policies create \
  --display-name="[P1] Rate limiter fail-open detected" \
  --condition-display-name="fail-open >= 1 in 5m" \
  --condition-filter='resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/rate_limit_fail_open_count"' \
  --condition-threshold-value=1 \
  --condition-threshold-comparison=COMPARISON_GT \
  --condition-threshold-duration=0s \
  --aggregation='{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_SUM"}' \
  --notification-channels=NOTIFICATION_CHANNEL_ID
```

### 6.2 App Check 拒否スパイク

- **条件:** `app_check_denied_count` の合計が 5分間で通常時より急増（初期値: 5分間で50件超）
- **理由:** クライアント不具合（トークン更新不良等）または攻撃の兆候

```bash
gcloud alpha monitoring policies create \
  --display-name="[P2] App Check denial spike" \
  --condition-display-name="denied count > 50 in 5m" \
  --condition-filter='resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/app_check_denied_count"' \
  --condition-threshold-value=50 \
  --condition-threshold-comparison=COMPARISON_GT \
  --condition-threshold-duration=0s \
  --aggregation='{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_SUM"}' \
  --notification-channels=NOTIFICATION_CHANNEL_ID
```

### 6.3 検索成功率バーンレート（upstream 別）

Cloud Monitoring のコンソールで比率アラート（SLO ベースの burn-rate アラート）として設定するのが最も簡実。手順:

1. Monitoring → SLO → 「SLO を作成」→ 対象メトリクスに `search_request_count`（フィルタ `status="success"`／`rate_limited!="true"` を良好イベント、`status IN ("success","failure")`／`rate_limited!="true"` を全イベントとする比率ベース SLO）を指定
2. §4 の目標値（例: navitime 98.0%／28日）を入力
3. burn-rate アラート（例: 「1時間で28日予算の2%を消費」）をウィザードから作成し、`NOTIFICATION_CHANNEL_ID` を紐付け

コンソール操作が前提な理由は §7 参照（比率条件を `gcloud alpha monitoring policies create` の単一コマンドで表現するのは可読性が低く事故りやすいため、SLO ウィザード経由を推奨する）。

### 6.4 p95 レイテンシ超過

- **条件:** `search_request_latency` の p95（`upstream` ラベルでフィルタ）が §4 の閾値を 15分間超過
- 例（navitime, 4000ms）:

```bash
gcloud alpha monitoring policies create \
  --display-name="[P3] navitime p95 latency > 4000ms" \
  --condition-display-name="p95 latencyMs > 4000 for 15m (upstream=navitime)" \
  --condition-filter='resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/search_request_latency" AND metric.labels.upstream="navitime"' \
  --condition-threshold-value=4000 \
  --condition-threshold-comparison=COMPARISON_GT \
  --condition-threshold-duration=900s \
  --aggregation='{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_PERCENTILE_95"}' \
  --notification-channels=NOTIFICATION_CHANNEL_ID
```

同様に `places`（800ms）、`routes-walk`（1500ms）、`routes-matrix`（2500ms）用にラベルと閾値だけ差し替えて複製する。

---

## 7. 運用メモ

- **IaC 未整備:** 本リポジトリに Terraform 等の IaC は導入されていない（issue #263 のレート制限再設計も TTL の IaC 化が未着手のまま）。本書のログベース指標・アラートポリシーは `gcloud`／Console 上での手動作成が前提。将来 Terraform 導入時は `google_logging_metric` / `google_monitoring_alert_policy` リソースへそのまま移植できる粒度で設計してある。
- **ログ量・コストへの配慮:** `rate_limit` の `decision="allowed"` は `metrics.ts` の設計上意図的にログ出力されない（`logRateLimit` のコメント参照）。許可は毎リクエストで発生し件数が支配的なため、全件ログするとログ量・コストが膨らむ。運用上アラート対象になるのは `blocked`／`fail-open` のみであり、現状のログ契約で必要十分。
- **成功率の分母欠落に注意:** App Check 拒否率（§3.3）はレート制限前で弾かれるため「保護前の全リクエスト数」がログに存在せず、真の「率」ではなく絶対件数ベースの近似にとどまる。分母を厳密化したい場合は `verifyAppCheck` 呼び出し自体をカウントするログを追加する必要があるが、本 issue のスコープ外とする。
- **Crashlytics 側は Cloud Logging 経路に乗らない:** クラッシュフリー率は Firebase Console の Crashlytics ダッシュボードで確認する。Cloud Monitoring 側でアラート化したい場合は BigQuery エクスポート経由になるが、現時点では未設定（将来課題）。
