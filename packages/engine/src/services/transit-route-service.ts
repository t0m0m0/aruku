// 移植元: lib/core/services/transit_route_service.dart

import type { RoutePlan } from '../models/route-plan';
import { notImplemented } from '../not-implemented';
import { seconds, type Duration } from '../time';
import type { CancellationToken } from './cancellation';
import type { RouteCandidate } from './hybrid-route-selector';
import type { HttpClient } from './http-client';
import type { PlanArgs, SearchEngine } from './route-service';
import type { RouteSearchMetrics } from './route-diagnostics';
import { SearchDeadline } from './search-deadline';
import type { TransitOption } from './transit-plan-parser';
import { TransitApiClient } from './transit-api-client';

export interface TransitRouteServiceInit {
  transitClient?: HttpClient;
  proxyClient?: HttpClient;
  transitBaseUrl?: string;
  proxyBaseUrl?: string;
  clock?: () => Date;
  cancellation?: CancellationToken | null;
  deadline?: SearchDeadline;

  /// 1検索分の定量指標（#309）の受け取り口。既定 null（本番は診断ログ出力のみ）。
  onMetrics?: (metrics: RouteSearchMetrics) => void;

  /// 到着アンカー第2波（#376）を departure 波の確定後に待つ猶予。テストが実時間に
  /// 依存せず猶予切れを再現できるよう注入可能にしてある。
  arrivalWaveGrace?: Duration | null;
}

/// 到着アンカー第2波の猶予の既定値。
///
/// **無期限に待たない理由:** 並列に投げた guidance の裾は実測 33〜43 秒まで伸びる。
/// 改善でしかない波を待ち切ると、その裾が毎検索の体感へそのまま乗る。
/// **0 にしない理由:** 両波は同時に発行済みで、この時点の第2波は既に departure 波
/// ぶんの時間を走っている。0 にすると、あと一息で返る応答まで捨てることになる。
export const defaultArrivalWaveGrace: Duration = seconds(5);

/// 見積り予算内候補を1回の並列パスで実測する短リストの本数上限（#315）。
/// 上限はレート制限（#161: 1検索最大13ファンアウト）に合わせる。
export const maxMeasureShortlist = 13;

/// base ごとのハイブリッド候補をマージするときの総数上限（#292）。
export const maxHybridCandidates = 40;

export class TransitRouteService implements SearchEngine {
  constructor(init: TransitRouteServiceInit = {}) {
    this.arrivalWaveGrace = init.arrivalWaveGrace ?? defaultArrivalWaveGrace;
    this.api = new TransitApiClient({
      transitClient: init.transitClient,
      proxyClient: init.proxyClient,
      transitBaseUrl: init.transitBaseUrl,
      proxyBaseUrl: init.proxyBaseUrl,
      cancellation: init.cancellation,
      deadline: init.deadline ?? SearchDeadline.none(),
    });
    this.deadline = init.deadline ?? SearchDeadline.none();
    this.clock = init.clock ?? (() => new Date());
    this.onMetrics = init.onMetrics ?? null;
  }

  /// Transit API / Google プロキシへの HTTP 通信（#169）。
  private readonly api: TransitApiClient;
  private readonly clock: () => Date;

  /// 検索1回分の締切（#300）。超過したら**引き直しの新ラウンドを起こさない**。
  /// ゲートするのは改善側だけで、必須の初期照会は締切で止めない。
  private readonly deadline: SearchDeadline;
  private readonly arrivalWaveGrace: Duration;
  private readonly onMetrics: ((metrics: RouteSearchMetrics) => void) | null;

  plan(args: PlanArgs): Promise<RoutePlan> {
    return notImplemented(
      `TransitRouteService.plan(${String(args.destination)}, ${String(this.clock)}, ${this.arrivalWaveGrace}, ${String(this.onMetrics)}, ${String(this.deadline.constructor.name)})`,
    );
  }

  close(): void {
    this.api.close();
  }

  /// 路線ファミリごとに代表（最短）option を選び、ハイブリッド生成の base 群を返す
  /// （#292）。先頭は単一最速 base に一致し、単一ファミリのときは挙動が変わらない。
  /// バス・コリドー2点未満は除外する。
  basesForHybrid(options: TransitOption[]): TransitOption[] {
    return notImplemented(`TransitRouteService.basesForHybrid(${options.length})`);
  }

  /// base ごとのハイブリッド群を [maxHybridCandidates] 本までマージ重複除去する（#292）。
  /// [within]（見積り到着が予算内か）が true の候補を**先に**上限まで詰め、余枠にのみ
  /// 予算外を足す。各フェーズ内は base 間ラウンドロビン（各 base は徒歩多い順）。
  mergeHybrids(
    perBase: RouteCandidate[][],
    within: (candidate: RouteCandidate) => boolean,
  ): RouteCandidate[] {
    return notImplemented(
      `TransitRouteService.mergeHybrids(${perBase.length}, ${typeof within})`,
    );
  }
}
