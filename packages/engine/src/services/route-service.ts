// 移植元: lib/core/services/route_service.dart
//
// Riverpod の `routeServiceProvider` は移していない。あれは DI の配線（HTTP
// クライアントの組み立てと App Check の適用）で、エンジンの仕様ではない。React 側の
// 配線として Phase 3（#386）で作り直す。

import type { GeoPoint } from '../models/geo-point';
import type { RoutePlan } from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { seconds, type Duration } from '../time';
import { CancellationToken } from './cancellation';

/// ルート計算の進捗段階。ローディング表示の3ステップに対応する。
export const RoutePhase = {
  routing: 'routing',
  walkability: 'walkability',
  building: 'building',
} as const;
export type RoutePhase = (typeof RoutePhase)[keyof typeof RoutePhase];

export interface PlanArgs {
  destination: string | null;
  destinationLatLng: GeoPoint | null;
  departure: TimeValue;
  arrival: TimeValue;
  origin?: GeoPoint | null;
  originName?: string | null;
  onProgress?: (phase: RoutePhase) => void;
}

export interface RouteService {
  plan(
    args: PlanArgs & {
      /// 検索単位のキャンセル境界（#259）。倒すと進行中の HTTP を切り、以降の
      /// 外部呼び出しを止める。null なら中断不能。
      cancellation?: CancellationToken | null;
    },
  ): Promise<RoutePlan>;
}

/// 検索1回分の実体。HTTP クライアントを所有し、[close] でそのソケットごと落とす。
export interface SearchEngine {
  plan(args: PlanArgs): Promise<RoutePlan>;

  /// 所有する HTTP クライアントを閉じ、in-flight を中断する。
  close(): void;
}

/// キャンセル可能な検索エンジンを組み立てる工場。
export type SearchEngineFactory = (
  cancellation: CancellationToken,
) => SearchEngine;

export class RouteException extends Error {
  constructor(readonly status: string) {
    super(`RouteException(${status})`);
    this.name = 'RouteException';
  }
}

/// plan 呼び出しごとに使い捨ての [SearchEngine] を組み立て、終了（正常・異常・
/// キャンセル）で必ず閉じる薄い façade（#259）。
export class SearchScopedRouteService implements RouteService {
  constructor(private readonly buildEngine: SearchEngineFactory) {}

  async plan(
    args: PlanArgs & { cancellation?: CancellationToken | null },
  ): Promise<RoutePlan> {
    const token = args.cancellation ?? new CancellationToken();
    const engine = this.buildEngine(token);

    let closed = false;
    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      engine.close();
    };

    // キャンセルは plan の完了を待たずに即 close する。await 中に走っている
    // fetch のソケットをその場で落とすのが中断の本体（#259）。
    token.onCancel(closeOnce);
    try {
      const result = await engine.plan(args);
      token.throwIfCanceled();
      return result;
    } catch (error) {
      // close で in-flight が落ちると get は任意の通信例外になる。キャンセル済みなら
      // それを [SearchCanceledException] へ揃え、呼び出し側が通信障害と取り違えない
      // ようにする。未キャンセルの素の失敗はそのまま伝播する。
      token.throwIfCanceled();
      throw error;
    } finally {
      closeOnce();
    }
  }
}

/// Transit API 直叩き1本あたりの応答待ち上限（#300）。
///
/// 上流 `/guidance/plan` は 9〜11 秒が正常・裾は 30 秒超（2026-07-17 実測。
/// docs/spec/route-optimization.md §2.2-6・§2.4）。実測サンプルの最大 30.8 秒を収める。
/// 延ばしても最悪待ち時間が膨らまないのは [searchDeadlineBudget] が別に天井を張るため。
export const transitRequestTimeout: Duration = seconds(35);

/// 徒歩プロキシ1本あたりの応答待ち上限（#300）。Cloud Functions 経由の Google Routes は
/// Transit API のような裾を持たないため 15 秒に据え置く。直叩きと同じにしないのは、
/// プロキシの無応答は本当に異常＝早く縮退した方が良いから。
export const proxyRequestTimeout: Duration = seconds(15);

/// 検索の**探索**（Transit 引き直し）に許す時間（#300）。超過後は引き直しを打ち切り、
/// 既得の候補で確定する。**検索全体の天井ではない**——確定経路の徒歩実測は締切後も走る。
export const searchDeadlineBudget: Duration = seconds(120);
