import {
  RoutePlan,
  RouteSegment,
  SegmentType,
  TimelineNode,
  type StandardTransitSummary,
  type TimetableSource,
} from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { differenceInMinutes } from '../time';

export const kcalPerKm = 57;

export const walkMetersPerMinute = 80.0;

export const trainMetersPerMinute = 500.0;

export function effectiveOffset(t: TimeValue): number {
  return t.isNow ? 0 : t.dateOffset;
}

export function absoluteMinutes(t: TimeValue): number {
  return t.totalMinutes + effectiveOffset(t) * 24 * 60;
}

export function budgetMinutes(departure: TimeValue, arrival: TimeValue): number {
  return absoluteMinutes(arrival) - absoluteMinutes(departure);
}

export function formatClock(dep: TimeValue, addMinutes: number): string {
  const total = dep.h * 60 + dep.m + addMinutes;
  const h = Math.trunc(total / 60) % 24;
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function advance(
  cum: number,
  seg: RouteSegment,
  anchor: Date | null,
): { cum: number; wait: number } {
  const dep = seg.depTime;
  const arr = seg.arrTime;
  if (anchor !== null && dep !== null) {
    const boardRel = differenceInMinutes(dep, anchor);
    const ride = arr !== null ? differenceInMinutes(arr, anchor) - boardRel : seg.minutes;
    if (ride >= 0) {
      const wait = boardRel > cum ? boardRel - cum : 0;
      return { cum: cum + wait + ride, wait };
    }
  }
  return { cum: cum + seg.minutes, wait: 0 };
}

export function arrivalMinutes(segments: RouteSegment[], departureAt: Date | null): number {
  let cum = 0;
  for (const seg of segments) {
    cum = advance(cum, seg, departureAt).cum;
  }
  return cum;
}

export function firstMissedTransit(segments: RouteSegment[], departureAt: Date): number | null {
  let cum = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dep = seg.depTime;
    const arr = seg.arrTime;
    if (isTransit(seg.type) && dep !== null) {
      const boardRel = differenceInMinutes(dep, departureAt);
      const consistent = arr === null || arr.getTime() >= dep.getTime();
      if (consistent && cum > boardRel) return i;
    }
    cum = advance(cum, seg, departureAt).cum;
  }
  return null;
}

export function hasUnverifiedTransit(segments: RouteSegment[]): boolean {
  return segments.some((s) => isTransit(s.type) && s.depTime === null);
}

export function maxBoardingWait(segments: RouteSegment[], departureAt: Date): number {
  let cum = 0;
  let maxWait = 0;
  for (const seg of segments) {
    const advanced = advance(cum, seg, departureAt);
    if (isTransit(seg.type) && seg.depTime !== null && advanced.wait > maxWait) {
      maxWait = advanced.wait;
    }
    cum = advanced.cum;
  }
  return maxWait;
}

function transitSub(seg: RouteSegment): string {
  if (seg.line !== null) return seg.line;
  switch (seg.type) {
    case SegmentType.train:
      return '電車';
    case SegmentType.bus:
      return 'バス';
    case SegmentType.walk:
      return '';
  }
}

function isTransit(type: SegmentType): boolean {
  switch (type) {
    case SegmentType.walk:
      return false;
    case SegmentType.train:
    case SegmentType.bus:
      return true;
  }
}

function boardingNode(
  departure: TimeValue,
  arrivedAt: string,
  seg: RouteSegment,
  arrivalCum: number,
  departureAt: Date | null,
): TimelineNode {
  const { wait } = advance(arrivalCum, seg, departureAt);
  return new TimelineNode({
    time: formatClock(departure, arrivalCum + wait),
    place: seg.fromName.length > 0 ? seg.fromName : arrivedAt,
    sub: transitSub(seg),
  });
}

function isUntimedWalk(seg: RouteSegment): boolean {
  return seg.type === SegmentType.walk && seg.depTime === null && seg.arrTime === null;
}

function joinWalks(a: RouteSegment, b: RouteSegment): RouteSegment {
  const aLast = a.polyline.at(-1);
  const overlaps = aLast !== undefined && b.polyline.length > 0 && aLast.isAt(b.polyline[0]);
  return new RouteSegment({
    type: SegmentType.walk,
    fromName: a.fromName,
    toName: b.toName,
    minutes: a.minutes + b.minutes,
    km: a.km === null && b.km === null ? null : (a.km ?? 0) + (b.km ?? 0),
    kcal: a.kcal === null && b.kcal === null ? null : (a.kcal ?? 0) + (b.kcal ?? 0),
    polyline: b.polyline.length === 0 ? [] : [...a.polyline, ...b.polyline.slice(overlaps ? 1 : 0)],
  });
}

function mergeConsecutiveWalks(segments: RouteSegment[]): RouteSegment[] {
  const merged: RouteSegment[] = [];
  for (const seg of segments) {
    const prev = merged.length === 0 ? null : merged[merged.length - 1];
    if (prev !== null && isUntimedWalk(prev) && isUntimedWalk(seg)) {
      merged[merged.length - 1] = joinWalks(prev, seg);
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

export interface BuildRoutePlanArgs {
  from: string;
  to: string;
  segments: RouteSegment[];
  departure: TimeValue;
  budgetMin: number;

  departureAt?: Date | null;

  standardTransit?: StandardTransitSummary | null;
  timetableSources?: TimetableSource[];
}

export function buildRoutePlan(args: BuildRoutePlanArgs): RoutePlan {
  const { from, to, departure, budgetMin } = args;
  const departureAt = args.departureAt ?? null;

  const segments = mergeConsecutiveWalks(args.segments.filter((s) => !s.isZeroWalk));

  const totalKm = segments.reduce((a, s) => a + (s.km ?? 0), 0);
  const walkKm = segments
    .filter((s) => s.type === SegmentType.walk)
    .reduce((a, s) => a + (s.km ?? 0), 0);
  const kcal = segments
    .filter((s) => s.type === SegmentType.walk)
    .reduce((a, s) => a + (s.kcal ?? 0), 0);

  const nodes: TimelineNode[] = [
    new TimelineNode({ time: formatClock(departure, 0), place: from, sub: '出発' }),
  ];
  if (segments.length === 0) {
    nodes.push(
      new TimelineNode({
        time: formatClock(departure, 0),
        place: to,
        sub: 0 <= budgetMin ? '到着 · 制限内 ✓' : '到着',
      }),
    );
  }
  let cum = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const cumAfter = advance(cum, seg, departureAt).cum;
    const isLast = i === segments.length - 1;
    if (isLast) {
      nodes.push(
        new TimelineNode({
          time: formatClock(departure, cumAfter),
          place: to,
          sub: cumAfter <= budgetMin ? '到着 · 制限内 ✓' : '到着',
        }),
      );
    } else {
      const next = segments[i + 1];
      const place = seg.toName;
      const incomingTransit = isTransit(seg.type);
      const outgoingTransit = isTransit(next.type);
      if (incomingTransit && outgoingTransit) {
        nodes.push(
          new TimelineNode({
            time: formatClock(departure, cumAfter),
            place,
            sub: '',
            cardBelow: false,
          }),
        );
        nodes.push(boardingNode(departure, place, next, cumAfter, departureAt));
      } else if (outgoingTransit) {
        nodes.push(boardingNode(departure, place, next, cumAfter, departureAt));
      } else {
        nodes.push(
          new TimelineNode({
            time: formatClock(departure, cumAfter),
            place,
            sub: '徒歩へ',
          }),
        );
      }
    }
    cum = cumAfter;
  }
  const totalMin = cum;

  return new RoutePlan({
    from,
    to,
    totalKm,
    totalMin,
    budgetMin,
    kcal,
    walkKm,
    walkRatio: totalKm === 0 ? 0 : walkKm / totalKm,
    segments,
    timelineNodes: nodes,
    standardTransit: args.standardTransit ?? null,
    timetableSources: args.timetableSources ?? [],
  });
}
