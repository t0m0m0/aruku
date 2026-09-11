// 移植元: lib/core/services/transit_api_client.dart

import type { JsonMap } from '../json';
import type { GeoPoint } from '../models/geo-point';
import { notImplemented } from '../not-implemented';
import type { CancellationToken } from './cancellation';
import type { HttpClient } from './http-client';
import { SearchDeadline } from './search-deadline';

export interface TransitApiClientInit {
  transitClient?: HttpClient;
  proxyClient?: HttpClient;

  /// 未指定時の既定（Dart 版の `AppConfig`）は移していない。設定の出どころは
  /// フロントの配線で、Phase 3（#386）で決める。
  transitBaseUrl?: string;
  proxyBaseUrl?: string;

  /// 検索1回分のキャンセル境界（#259）。null なら中断不能（既定）。
  cancellation?: CancellationToken | null;

  /// 検索1回分の締切（#300）。既定（[SearchDeadline.none]）は無期限。
  deadline?: SearchDeadline;
}

/// Transit API（`/guidance/plan` 直叩き）と Google Routes プロキシへの HTTP 通信を担う
/// クライアント（#169）。
export class TransitApiClient {
  constructor(init: TransitApiClientInit = {}) {
    this.transit = init.transitClient ?? null;
    this.proxy = init.proxyClient ?? null;
    this.rawTransitBaseUrl = init.transitBaseUrl ?? '';
    this.rawProxyBaseUrl = init.proxyBaseUrl ?? '';
    this.cancellation = init.cancellation ?? null;
    this.deadline = init.deadline ?? SearchDeadline.none();
  }

  private readonly transit: HttpClient | null;
  private readonly proxy: HttpClient | null;
  private readonly rawTransitBaseUrl: string;
  private readonly rawProxyBaseUrl: string;
  readonly cancellation: CancellationToken | null;
  readonly deadline: SearchDeadline;

  /// `/guidance/plan` の実 HTTP 往復本数（初回＋引き直し）。
  get guidanceCalls(): number {
    return notImplemented('TransitApiClient.guidanceCalls');
  }

  /// 上記のうち、同一 URI の重複発行だった本数（guidance キャッシュで消える上限）。
  get guidanceDupCalls(): number {
    return notImplemented('TransitApiClient.guidanceDupCalls');
  }

  /// Google 徒歩ルート（enrich）の実 HTTP 往復本数。
  get walkCalls(): number {
    return notImplemented('TransitApiClient.walkCalls');
  }

  /// Google 徒歩マトリクスの実 HTTP 往復本数。
  get matrixCalls(): number {
    return notImplemented('TransitApiClient.matrixCalls');
  }

  /// 正規化済みの Transit API ベース URL（テスト・観測用）。
  get transitBaseUrl(): string {
    return notImplemented(
      `TransitApiClient.transitBaseUrl(${this.rawTransitBaseUrl})`,
    );
  }

  /// Transit API のベース URL が設定済みか。未設定なら呼び出し側は `NO_TRANSIT_API`
  /// を投げる。設定知識を通信層に閉じ込め、ドメイン層が URL 文字列を覗かないための述語。
  get hasTransitApi(): boolean {
    return notImplemented(
      `TransitApiClient.hasTransitApi(${this.rawProxyBaseUrl})`,
    );
  }

  /// [start]→[goal] を [at] 発で `/guidance/plan` に問い合わせ、生 JSON を返す。
  /// 非200は `RouteException('HTTP <code>')`、無応答は `RouteException('TIMEOUT')`。
  fetchGuidanceAt(
    start: GeoPoint,
    goal: GeoPoint,
    at: Date,
    options: { allowBus?: boolean } = {},
  ): Promise<JsonMap> {
    return notImplemented(
      `TransitApiClient.fetchGuidanceAt(${start.lat}, ${goal.lat}, ${at.toISOString()}, ${String(options.allowBus)})`,
    );
  }

  /// [start]→[goal] を「[departureAt] から [budgetMin] 分後」到着で `/guidance/plan` に
  /// 問い合わせ、生 JSON を返す（到着アンカー第2波・#376）。
  fetchGuidanceArrivalAt(
    start: GeoPoint,
    goal: GeoPoint,
    departureAt: Date,
    budgetMin: number,
    options: { allowBus?: boolean } = {},
  ): Promise<JsonMap> {
    return notImplemented(
      `TransitApiClient.fetchGuidanceArrivalAt(${start.lat}, ${goal.lat}, ${budgetMin}, ${String(options.allowBus)})`,
    );
  }

  /// [origins]×[dests] の徒歩マトリクスを Google プロキシで一括実測し、生の要素配列を返す。
  /// 取得失敗（非200・タイムアウト・非配列）は null（呼び出し側は直線推定へフォールバック）。
  fetchWalkMatrix(
    origins: GeoPoint[],
    dests: GeoPoint[],
  ): Promise<unknown[] | null> {
    return notImplemented(
      `TransitApiClient.fetchWalkMatrix(${origins.length}, ${dests.length})`,
    );
  }

  /// [origin]→[dest] の徒歩を Google Routes(WALK, プロキシ経由)で取得した生ボディを返す。
  fetchWalkRoute(origin: GeoPoint, dest: GeoPoint): Promise<JsonMap> {
    return notImplemented(
      `TransitApiClient.fetchWalkRoute(${origin.lat}, ${dest.lat})`,
    );
  }

  /// 保持するクライアントを閉じ、in-flight のリクエストを中断する（#259）。
  close(): void {
    notImplemented(
      `TransitApiClient.close(${String(this.transit !== null)}, ${String(this.proxy !== null)})`,
    );
  }
}
