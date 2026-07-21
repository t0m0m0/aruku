// 構造化ログ経由の可観測性ヘルパー（issue #268）。
//
// Cloud Logging のログベース指標は jsonPayload の特定フィールドでフィルタする。
// 全イベントに共通の `event` フィールドを持たせることで、指標側は
// jsonPayload.event="search_request" のようにフィルタできる。
//
// PII ポリシー: 生 IP・検索クエリ文字列・座標・駅名は一切ログに含めない。
// 含めてよいのは endpoint 名・upstream 名・ステータスコード・レイテンシ・件数などの
// メタデータのみ（rate-limiter 側は既に IP を HMAC 化した上でここへは渡さない）。
import { logger } from "firebase-functions";

export type RequestStatus = "success" | "failure";

export interface RequestOutcomeParams {
  /** どのハンドラ／アクションか（例: "placesProxy.autocomplete", "navitimeProxy"）。 */
  endpoint: string;
  /** どの上流 API か（例: "places", "navitime", "routes-walk", "routes-matrix"）。 */
  upstream: string;
  status: RequestStatus;
  latencyMs: number;
  /** 上流の HTTP ステータスコード（取得できた場合のみ）。 */
  httpStatus?: number;
  /** 上流が 2xx でもボディがエラー形状だった失敗（クォータ/認証/スキーマ異常）。 */
  semanticFailure?: boolean;
}

/** 検索リクエストの成否・レイテンシ・上流ステータスを記録する。 */
export function logRequestOutcome(params: RequestOutcomeParams): void {
  const { endpoint, upstream, status, latencyMs, httpStatus, semanticFailure } =
    params;
  const payload = {
    event: "search_request",
    endpoint,
    upstream,
    status,
    latencyMs,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    // 429 は「上流のレート制限」という別種の失敗のため、指標側で切り出して
    // 集計できるよう明示フラグを立てる（httpStatus だけでも絞り込めるが、
    // 「429 特定可能」というログ契約を型として残すため専用フィールドにする）。
    ...(httpStatus === 429 ? { rateLimited: true } : {}),
    // httpStatus=200 の failure を「HTTP は成功・意味的に失敗」と判別可能に保つ。
    ...(semanticFailure ? { semanticFailure: true } : {}),
  };
  if (status === "success") {
    logger.info("search_request", payload);
  } else {
    // logger.error(...) は payload だけを渡すと Error スタックを合成し
    // Cloud Error Reporting が例外として拾う（実エラーではない指標イベント
    // で発火し、本当の関数例外を埋もれさせる）。write で LogEntry を直接
    // 組み立て、severity だけ ERROR にして jsonPayload.event でのフィルタは
    // 維持しつつ Error Reporting への計上を避ける。
    logger.write({ severity: "ERROR", message: "search_request", ...payload });
  }
}

export interface RequestLatencyParams {
  /** どのハンドラか（例: "googleWalkMatrixProxy"）。 */
  endpoint: string;
  /** ハンドラ入口〜応答完了までの全体レイテンシ（ミリ秒）。 */
  totalLatencyMs: number;
  /** 応答の HTTP ステータスコード。 */
  httpStatus: number;
}

// なぜ search_request に latencyMs を足すのではなく別イベントにするか:
//   search_request の latencyMs は #274 の不変条件で「上流 API 呼び出し区間のみ」を
//   producer 内で計上する（dedupe の single-flight 相乗り・TTL ヒットには計上しない）。
//   ここで測るのはハンドラ入口〜応答＝App Check 検証・レートリミッタ・キャッシュ判定を
//   含む全体で、上流を一度も呼ばない要求（キャッシュヒット等）でも出す。両者を同じ
//   イベント・同じフィールドに混ぜると #268 SLO と #274 計測が汚れるため、独立イベントに
//   分ける。severity は情報（info）——失敗応答でも「レイテンシ計測」であって関数エラー
//   ではないので、logger.error/write に寄せて Error Reporting を汚さない。
/** ハンドラ入口〜応答までのリクエスト全体レイテンシを記録する（#309）。 */
export function logRequestLatency(params: RequestLatencyParams): void {
  logger.info("request_latency", {
    event: "request_latency",
    endpoint: params.endpoint,
    totalLatencyMs: params.totalLatencyMs,
    httpStatus: params.httpStatus,
  });
}

export type AppCheckDenialReason = "missing" | "invalid" | "replayed";

export interface AppCheckDeniedParams {
  endpoint: string;
  reason: AppCheckDenialReason;
}

/** App Check 検証の拒否イベントを記録する。 */
export function logAppCheckDenied(params: AppCheckDeniedParams): void {
  logger.warn("app_check_denied", {
    event: "app_check_denied",
    endpoint: params.endpoint,
    reason: params.reason,
  });
}

export type RateLimitDecision = "allowed" | "blocked" | "fail-open";

/**
 * フェイルオープンの原因種別。
 * - `config`: 設定するまで永続的に保護が無効（Firestore 未プロビジョニング、HMAC 鍵未登録）。
 * - `transient`: 競合・一時不通など、放置しても自然に解消しうるもの。
 */
export type FailOpenReason = "config" | "transient";

// なぜ optional フィールドではなく判別可能合併型か:
//   `reason` を optional にすると `{ decision: "fail-open" }` が型検査を通り、
//   理由なしのフェイルオープンが再び書けてしまう。「fail-open は必ず理由を持つ」
//   を規約ではなく型で固定し、#301 の「静かに通る」構造の再発を封じる。
export type RateLimitParams =
  | { decision: Exclude<RateLimitDecision, "fail-open"> }
  | { decision: "fail-open"; reason: FailOpenReason };

// なぜ "allowed" を実際には呼び出し側から出さないか:
//   許可はリクエストごとに発生し件数が支配的なため、毎回ログすると量・コストが
//   膨らむ。ブロック／フェイルオープンだけが運用上のアラート対象であり、"allowed" は
//   契約上の型としてのみ残す（将来サンプリング付きで出す拡張の余地を潰さないため）。
/** レート制限の判定イベント（特にフェイルオープン）を記録する。 */
export function logRateLimit(params: RateLimitParams): void {
  const payload = {
    event: "rate_limit",
    decision: params.decision,
    ...(params.decision === "fail-open" ? { reason: params.reason } : {}),
  };
  if (params.decision === "fail-open") {
    // search_request の failure 経路と同じ理由で write を使う（logger.error は
    // Error Reporting に synthetic stack 付きで計上される）。
    logger.write({ severity: "ERROR", message: "rate_limit", ...payload });
  } else if (params.decision === "blocked") {
    logger.warn("rate_limit", payload);
  } else {
    logger.info("rate_limit", payload);
  }
}
