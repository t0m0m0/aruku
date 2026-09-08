// 移植元: lib/core/services/hybrid_route_selector.dart

import type { RouteSegment } from '../models/route-plan';
import { notImplemented } from '../not-implemented';

export interface RouteCandidateInit {
  from: string;
  to: string;
  segments: RouteSegment[];
}

/// 経路候補（全徒歩・ハイブリッド・標準乗換のいずれか）。データ源に依存しない。
export class RouteCandidate {
  constructor(init: RouteCandidateInit) {
    this.from = init.from;
    this.to = init.to;
    this.segments = init.segments;
  }

  readonly from: string;
  readonly to: string;
  readonly segments: RouteSegment[];

  get totalMin(): number {
    return notImplemented('RouteCandidate.totalMin');
  }

  get walkMinutes(): number {
    return notImplemented('RouteCandidate.walkMinutes');
  }

  get transferCount(): number {
    return notImplemented('RouteCandidate.transferCount');
  }

  get totalKm(): number {
    return notImplemented('RouteCandidate.totalKm');
  }

  get walkKm(): number {
    return notImplemented('RouteCandidate.walkKm');
  }
}
