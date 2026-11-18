import type { GeoPoint } from './geo-point';

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

  readonly depTime: Date | null;

  readonly arrTime: Date | null;

  get isZeroWalk(): boolean {
    return this.type === SegmentType.walk && this.minutes === 0 && (this.km ?? 0) < 0.05;
  }

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

  readonly cardBelow: boolean;
}

export interface StandardTransitSummary {
  walkMinutes: number;
  totalMin: number;
}

export interface TimetableSource {
  feedId: string;
  fetchedAt: Date;
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
  standardTransit?: StandardTransitSummary | null;
  timetableSources?: TimetableSource[];
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
    this.standardTransit = init.standardTransit ?? null;
    this.timetableSources = init.timetableSources ?? [];
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

  readonly standardTransit: StandardTransitSummary | null;

  readonly timetableSources: TimetableSource[];
}
