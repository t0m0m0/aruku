// 移植元: lib/core/models/route_plan.dart

import { notImplemented } from '../not-implemented';
import type { GeoPoint } from './geo-point';

/// Dart の `enum SegmentType` に対応する。
///
/// TypeScript の `enum` ではなく文字列リテラルの定数オブジェクトにしているのは、
/// テスト失敗時の差分に `0` ではなく `'walk'` が出るため。`SegmentType.walk` という
/// 呼び出し側の書き方は Dart と同じままになる。
export const SegmentType = {
  walk: 'walk',
  train: 'train',
  bus: 'bus',
} as const;
export type SegmentType = (typeof SegmentType)[keyof typeof SegmentType];

export interface RouteSegmentInit {
  type: SegmentType;
  fromName: string;
  toName: string;
  minutes: number;
  km?: number | null;
  kcal?: number | null;
  line?: string | null;
  fare?: number | null;
  stops?: number | null;
  polyline?: GeoPoint[];
  depTime?: Date | null;
  arrTime?: Date | null;
}

export interface RouteSegmentPatch {
  fromName?: string;
  toName?: string;
  minutes?: number;
  depTime?: Date;
  arrTime?: Date;
}

export class RouteSegment {
  constructor(init: RouteSegmentInit) {
    this.type = init.type;
    this.fromName = init.fromName;
    this.toName = init.toName;
    this.minutes = init.minutes;
    this.km = init.km ?? null;
    this.kcal = init.kcal ?? null;
    this.line = init.line ?? null;
    this.fare = init.fare ?? null;
    this.stops = init.stops ?? null;
    this.polyline = init.polyline ?? [];
    this.depTime = init.depTime ?? null;
    this.arrTime = init.arrTime ?? null;
  }

  readonly type: SegmentType;
  readonly fromName: string;
  readonly toName: string;
  readonly minutes: number;
  readonly km: number | null;
  readonly kcal: number | null;
  readonly line: string | null;
  readonly fare: number | null;
  readonly stops: number | null;
  readonly polyline: GeoPoint[];

  /// この区間の出発（電車は乗車）絶対時刻。時刻表データが揃う電車区間でのみ設定し、
  /// 徒歩・時刻欠落の概算区間では null。
  readonly depTime: Date | null;

  /// この区間の到着（電車は降車）絶対時刻。設定条件は [depTime] と同じ。
  readonly arrTime: Date | null;

  /// 表示上 0.0km・0分に丸まる徒歩区間か。
  get isZeroWalk(): boolean {
    return notImplemented('RouteSegment.isZeroWalk');
  }

  /// Dart 版と同じく null への差し戻しはできない（`?? this.x` 相当）。
  copyWith(patch: RouteSegmentPatch = {}): RouteSegment {
    return new RouteSegment({
      type: this.type,
      fromName: patch.fromName ?? this.fromName,
      toName: patch.toName ?? this.toName,
      minutes: patch.minutes ?? this.minutes,
      km: this.km,
      kcal: this.kcal,
      line: this.line,
      fare: this.fare,
      stops: this.stops,
      polyline: this.polyline,
      depTime: patch.depTime ?? this.depTime,
      arrTime: patch.arrTime ?? this.arrTime,
    });
  }
}

export interface TimelineNodeInit {
  time: string;
  place: string;
  sub: string;
  cardBelow?: boolean;
}

export class TimelineNode {
  constructor(init: TimelineNodeInit) {
    this.time = init.time;
    this.place = init.place;
    this.sub = init.sub;
    this.cardBelow = init.cardBelow ?? true;
  }

  readonly time: string;
  readonly place: string;
  readonly sub: string;

  /// このノードの直下にレッグ（区間）カードを描くか。
  readonly cardBelow: boolean;
}

export interface RoutePlanInit {
  from: string;
  to: string;
  totalKm: number;
  totalMin: number;
  budgetMin: number;
  kcal: number;
  walkKm: number;
  walkRatio: number;
  segments: RouteSegment[];
  timelineNodes: TimelineNode[];
}

export class RoutePlan {
  constructor(init: RoutePlanInit) {
    this.from = init.from;
    this.to = init.to;
    this.totalKm = init.totalKm;
    this.totalMin = init.totalMin;
    this.budgetMin = init.budgetMin;
    this.kcal = init.kcal;
    this.walkKm = init.walkKm;
    this.walkRatio = init.walkRatio;
    this.segments = init.segments;
    this.timelineNodes = init.timelineNodes;
  }

  readonly from: string;
  readonly to: string;
  readonly totalKm: number;
  readonly totalMin: number;
  readonly budgetMin: number;
  readonly kcal: number;
  readonly walkKm: number;
  readonly walkRatio: number;
  readonly segments: RouteSegment[];
  readonly timelineNodes: TimelineNode[];
}
