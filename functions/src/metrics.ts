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
    logger.error("search_request", payload);
  }
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

export interface RateLimitParams {
  decision: RateLimitDecision;
}

// なぜ "allowed" を実際には呼び出し側から出さないか:
//   許可はリクエストごとに発生し件数が支配的なため、毎回ログすると量・コストが
//   膨らむ。ブロック／フェイルオープンだけが運用上のアラート対象であり、"allowed" は
//   契約上の型としてのみ残す（将来サンプリング付きで出す拡張の余地を潰さないため）。
/** レート制限の判定イベント（特にフェイルオープン）を記録する。 */
export function logRateLimit(params: RateLimitParams): void {
  const payload = { event: "rate_limit", decision: params.decision };
  if (params.decision === "fail-open") {
    logger.error("rate_limit", payload);
  } else if (params.decision === "blocked") {
    logger.warn("rate_limit", payload);
  } else {
    logger.info("rate_limit", payload);
  }
}
