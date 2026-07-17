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
| `search_request` | `fetchUpstream`（全プロキシ共通） | `endpoint`（例: `placesProxy.autocomplete`, `navitimeProxy`）, `upstream`（`places`\|`navitime`\|`routes-walk`\|`routes-matrix`）, `status`（`success`\|`failure`）, `latencyMs`, `httpStatus`（任意・タイムアウトは504）, `rateLimited`（上流429のときのみ`true`）, `semanticFailure`（上流が2xxでもボディがエラー形状＝クライアントへ502変換される失敗のときのみ`true`。このとき`status="failure"`・`httpStatus`は上流値のまま、通常200） | success→info, failure→error |
| `app_check_denied` | `verifyAppCheck` | `endpoint`, `reason`（`missing`\|`invalid`\|`replayed`） | warn |
| `rate_limit` | `checkRateLimit` 呼び出し元 | `decision`（`blocked`\|`fail-open`。`allowed`は型上のみ存在し実際には出力されない）, `reason`（`fail-open`のときのみ必ず付く。`config`\|`transient`） | blocked→warn, fail-open→error |

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

`rate_limit` かつ `decision="fail-open"` の件数。フェイルオープンは「レート制限を検証できず制限をかけずに通した」状態で、保護が機能していないことを意味する。

ただしフェイルオープンは**一枚岩に扱ってはいけない**。`reason` で二分し、別々の指標・アラートとして運用する（#301）。

| `reason` | 原因 | 性質 | 運用 |
|---|---|---|---|
| `config` | Firestore 未プロビジョニング（API 未有効・DB 未作成・IAM 不足）、`RATE_LIMIT_HMAC_KEY` 未登録／32文字未満 | 人が設定するまで**永続的に**保護が無効。時間経過では絶対に解消しない | 1件でも即 P1（§6.1） |
| `transient` | ホットドキュメント競合によるリトライ枯渇、一時的な不通・タイムアウト | 単発は README「制約・トレードオフ」で**設計上許容**。バースト局面で必然的に出る | 急増のみ P3（§6.1） |

**なぜ分けるか:** かつて fail-open は理由を持たず、`config` と `transient` が同一の信号だった。`transient` は許容済みで恒常的に出るため「1件でも P1」は必ずノイズとして黙らされ、その結果 #301 では本番の Firestore API 未有効化による**恒久的なフェイルオープンが数か月検知されなかった**。`transient` を黙らせても `config` が鳴り続ける構造にすることが、この指標の存在意義である。

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

**作成方式に関する注意:** `gcloud logging metrics create` のフラグは `--description`／`--log-filter`（＋任意の `--bucket-name`）のみで、ラベル抽出・値抽出・分布バケットを指定するフラグは存在しない。カスタムラベル付き・分布型のメトリクスは **LogMetric 定義ファイル（YAML）＋ `--config-from-file`** で作成するのが公式手順。以下、ラベル付きメトリクスはすべてこの方式で定義する（YAML は作業ディレクトリに一時作成して使う。リポジトリ管理対象にはしない — §7 の IaC 未整備を参照）。

### 5.1 検索リクエスト件数（成功/失敗、upstream・status 別ラベル付きカウンタ）

```yaml
# search_request_count.yaml
description: "search_request イベントの件数（upstream/status/rate_limited 別ラベル付き）"
filter: >-
  resource.type="cloud_run_revision"
  jsonPayload.event="search_request"
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: upstream
      valueType: STRING
    - key: status
      valueType: STRING
    - key: rate_limited
      valueType: STRING
labelExtractors:
  upstream: EXTRACT(jsonPayload.upstream)
  status: EXTRACT(jsonPayload.status)
  rate_limited: EXTRACT(jsonPayload.rateLimited)
```

```bash
gcloud logging metrics create search_request_count \
  --config-from-file=search_request_count.yaml
```

成功率は Monitoring 側で `rate_limited != "true"` を除外して `status="success"` / (`status="success"` + `status="failure"`) を計算する（MQLもしくはアラートポリシーの比率条件）。

### 5.2 検索レイテンシ分布（upstream 別、成功リクエストのみ）

```yaml
# search_request_latency.yaml
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
      valueType: STRING
labelExtractors:
  upstream: EXTRACT(jsonPayload.upstream)
valueExtractor: EXTRACT(jsonPayload.latencyMs)
bucketOptions:
  explicitBuckets:
    bounds: [50, 100, 200, 400, 800, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 12000]
```

```bash
gcloud logging metrics create search_request_latency \
  --config-from-file=search_request_latency.yaml
```

### 5.3 App Check 拒否件数（endpoint・reason 別ラベル）

```yaml
# app_check_denied_count.yaml
description: "app_check_denied イベントの件数（endpoint/reason 別ラベル）"
filter: >-
  resource.type="cloud_run_revision"
  jsonPayload.event="app_check_denied"
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: endpoint
      valueType: STRING
    - key: reason
      valueType: STRING
labelExtractors:
  endpoint: EXTRACT(jsonPayload.endpoint)
  reason: EXTRACT(jsonPayload.reason)
```

```bash
gcloud logging metrics create app_check_denied_count \
  --config-from-file=app_check_denied_count.yaml
```

### 5.4 レート制限判定件数（decision 別ラベル）

```yaml
# rate_limit_decision_count.yaml
description: "rate_limit イベントの件数（decision/reason別ラベル。blocked/fail-openのみ、allowedは出力されない）"
filter: >-
  resource.type="cloud_run_revision"
  jsonPayload.event="rate_limit"
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: decision
      valueType: STRING
    - key: reason
      valueType: STRING
labelExtractors:
  decision: EXTRACT(jsonPayload.decision)
  # blocked には reason が無いため空ラベルになる（fail-open のみ config/transient が入る）。
  reason: EXTRACT(jsonPayload.reason)
```

```bash
gcloud logging metrics create rate_limit_decision_count \
  --config-from-file=rate_limit_decision_count.yaml
```

アラート条件（§6）をシンプルに保つため、`reason` ごとにフィルタを絞った単独カウンタも作る。いずれもラベルなしの単純カウンタなので、フラグ指定のみで作成できる。

```bash
# 恒久的な設定不備。1件でも出たら保護が「設定するまでずっと無効」を意味する（§6.1）。
gcloud logging metrics create rate_limit_fail_open_config_count \
  --description="rate_limit fail-open (reason=config) の件数。設定するまで保護が恒久的に無効" \
  --log-filter='resource.type="cloud_run_revision" AND jsonPayload.event="rate_limit" AND jsonPayload.decision="fail-open" AND jsonPayload.reason="config"'

# 競合・一時不通。単発は許容、急増のみ関心（§6.2）。
gcloud logging metrics create rate_limit_fail_open_transient_count \
  --description="rate_limit fail-open (reason=transient) の件数。単発は設計上許容・急増のみ監視" \
  --log-filter='resource.type="cloud_run_revision" AND jsonPayload.event="rate_limit" AND jsonPayload.decision="fail-open" AND jsonPayload.reason="transient"'
```

**既存環境からの移行:** 旧 `rate_limit_fail_open_count`（reason 無しの全 fail-open）を作成済みの場合は、上記2つへ置き換えたうえで削除する（`gcloud logging metrics delete rate_limit_fail_open_count`）。残すと §6.1 と重複発火し、`transient` でも P1 が鳴る従来の問題がそのまま残る。

---

## 6. アラートポリシー

通知先は未整備（Slack Webhook 等は本 issue の対象外）。まずは email 通知チャンネルを作成し、後日 Slack 連携に差し替える想定。

```bash
gcloud alpha monitoring channels create \
  --display-name="aruku-functions-alerts-email" \
  --type=email \
  --channel-labels=email_address=YOUR_ONCALL_EMAIL@example.com
```

作成した通知チャンネル名（`projects/PROJECT_ID/notificationChannels/CHANNEL_ID` 形式。`gcloud alpha monitoring channels list` で確認）を以下のポリシーに紐付ける。

**作成方式に関する注意:** `gcloud alpha monitoring policies create` に `--condition-threshold-value` のようなフラグは存在しない。条件は (a) `--condition-filter` + `--if "> 閾値"` + `--duration` + `--aggregation` のフラグ組み合わせ、または (b) **AlertPolicy 定義ファイル（YAML/JSON）＋ `--policy-from-file`** で指定する。閾値・集計・通知先を1ファイルで宣言でき将来の Terraform 移植（§7）とも整合するため、本書は (b) に統一する。

### 6.1 レート制限フェイルオープン（最優先・即時）

`reason` ごとに緊急度が根本的に違うため、**2本のポリシーに分ける**（§3.4）。1本にまとめると、許容済みの `transient` が P1 を鳴らし続け、ポリシーごとミュートされて `config` を取り逃す（#301 の再発）。

#### 6.1.a `reason=config`（P1・即時）

- **条件:** `rate_limit_fail_open_config_count` が 5分間で 1件以上
- **理由:** 設定するまで保護が**恒久的に**無効。1件出た時点で「今この瞬間もレート制限は全く効いていない」を意味する。時間経過では解消しないため、様子見は無意味
- **対応:** README「レートリミッタ（Firestore）」節のプロビジョニング手順を実施（Firestore DB 作成／`RATE_LIMIT_HMAC_KEY` 登録／rules デプロイ／TTL 設定）
- **系列横断リデューサ不要:** これは「1件でも出たら発火」の存在検知（`thresholdValue: 0`）で、いずれかの系列が非0なら発火すれば目的を満たす。合計値を閾値と比較するわけではないため系列単位評価でよく、`crossSeriesReducer` は付けない（このカウンタは元々ラベルなしの単一系列でもある）。

```yaml
# policy_fail_open_config.yaml
displayName: "[P1] Rate limiter fail-open (misconfiguration) — protection permanently off"
combiner: OR
conditions:
  - displayName: "fail-open reason=config >= 1 in 5m"
    conditionThreshold:
      filter: >-
        resource.type="cloud_run_revision" AND
        metric.type="logging.googleapis.com/user/rate_limit_fail_open_config_count"
      comparison: COMPARISON_GT
      thresholdValue: 0
      duration: 0s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_SUM
notificationChannels:
  - projects/PROJECT_ID/notificationChannels/CHANNEL_ID
```

#### 6.1.b `reason=transient`（P3・急増のみ）

- **条件:** `rate_limit_fail_open_transient_count` が 5分間で 20件以上
- **理由:** 単発の競合フェイルオープンは設計上許容（README「制約・トレードオフ」）のため存在検知にしない。一方で継続的な多発は、ホットドキュメント競合が常態化し「最も制限したいバースト局面で上限が緩む」ことを意味するので、設計見直し（シャーディング等）の判断材料として拾う
- **閾値の根拠:** 実測値がまだ無いための暫定値。本番でプロビジョニング後に定常のフェイルオープン率を観測し、誤検知が出るなら引き上げる

```yaml
# policy_fail_open_transient.yaml
displayName: "[P3] Rate limiter fail-open (transient) sustained spike"
combiner: OR
conditions:
  - displayName: "fail-open reason=transient >= 20 in 5m"
    conditionThreshold:
      filter: >-
        resource.type="cloud_run_revision" AND
        metric.type="logging.googleapis.com/user/rate_limit_fail_open_transient_count"
      comparison: COMPARISON_GT
      thresholdValue: 20
      duration: 0s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_SUM
notificationChannels:
  - projects/PROJECT_ID/notificationChannels/CHANNEL_ID
```

```bash
gcloud alpha monitoring policies create --policy-from-file=policy_fail_open_config.yaml
gcloud alpha monitoring policies create --policy-from-file=policy_fail_open_transient.yaml
```

### 6.2 App Check 拒否スパイク

- **条件:** `app_check_denied_count` の合計が 5分間で通常時より急増（初期値: 5分間で50件超）
- **理由:** クライアント不具合（トークン更新不良等）または攻撃の兆候

`app_check_denied_count` は endpoint／reason ラベルで複数時系列に分かれる。per-series aligner だけでは各系列を個別に閾値評価するため、拒否が複数ラベルに分散すると（例: 4エンドポイントに各20件＝計80件）系列単位では閾値未満となり「合計」スパイクを取りこぼす。`crossSeriesReducer: REDUCE_SUM` を `groupByFields` 空（＝全系列合算）で加え、閾値比較の前に全ラベルを跨いだ総数へ畳み込む。

```yaml
# policy_app_check_spike.yaml
displayName: "[P2] App Check denial spike"
combiner: OR
conditions:
  - displayName: "total denied count > 50 in 5m (all labels)"
    conditionThreshold:
      filter: >-
        resource.type="cloud_run_revision" AND
        metric.type="logging.googleapis.com/user/app_check_denied_count"
      comparison: COMPARISON_GT
      thresholdValue: 50
      duration: 0s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_SUM
          crossSeriesReducer: REDUCE_SUM
          groupByFields: []
notificationChannels:
  - projects/PROJECT_ID/notificationChannels/CHANNEL_ID
```

```bash
gcloud alpha monitoring policies create --policy-from-file=policy_app_check_spike.yaml
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

```yaml
# policy_latency_navitime.yaml
displayName: "[P3] navitime p95 latency > 4000ms"
combiner: OR
conditions:
  - displayName: "p95 latencyMs > 4000 for 15m (upstream=navitime)"
    conditionThreshold:
      filter: >-
        resource.type="cloud_run_revision" AND
        metric.type="logging.googleapis.com/user/search_request_latency" AND
        metric.labels.upstream="navitime"
      comparison: COMPARISON_GT
      thresholdValue: 4000
      duration: 900s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_PERCENTILE_95
notificationChannels:
  - projects/PROJECT_ID/notificationChannels/CHANNEL_ID
```

```bash
gcloud alpha monitoring policies create --policy-from-file=policy_latency_navitime.yaml
```

同様に `places`（800ms）、`routes-walk`（1500ms）、`routes-matrix`（2500ms）用に `metric.labels.upstream` と `thresholdValue` だけ差し替えたファイルを複製する。

---

## 7. 運用メモ

- **IaC 未整備:** 本リポジトリに Terraform 等の IaC は導入されていない（issue #263 のレート制限再設計も TTL の IaC 化が未着手のまま）。本書のログベース指標・アラートポリシーは `gcloud`／Console 上での手動作成が前提。将来 Terraform 導入時は `google_logging_metric` / `google_monitoring_alert_policy` リソースへそのまま移植できる粒度で設計してある。
- **ログ量・コストへの配慮:** `rate_limit` の `decision="allowed"` は `metrics.ts` の設計上意図的にログ出力されない（`logRateLimit` のコメント参照）。許可は毎リクエストで発生し件数が支配的なため、全件ログするとログ量・コストが膨らむ。運用上アラート対象になるのは `blocked`／`fail-open` のみであり、現状のログ契約で必要十分。
- **成功率の分母欠落に注意:** App Check 拒否率（§3.3）はレート制限前で弾かれるため「保護前の全リクエスト数」がログに存在せず、真の「率」ではなく絶対件数ベースの近似にとどまる。分母を厳密化したい場合は `verifyAppCheck` 呼び出し自体をカウントするログを追加する必要があるが、本 issue のスコープ外とする。
- **Crashlytics 側は Cloud Logging 経路に乗らない:** クラッシュフリー率は Firebase Console の Crashlytics ダッシュボードで確認する。Cloud Monitoring 側でアラート化したい場合は BigQuery エクスポート経由になるが、現時点では未設定（将来課題）。
