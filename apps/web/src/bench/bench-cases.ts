// 厳密走査の A/B 計測（#462）で回す検索の条件を組み立てる。

import { TimeValue } from '@aruku/engine/models/time-value';
import { SegmentType } from '@aruku/engine/models/route-plan';
import {
  arrivalMinutes,
  firstMissedTransit,
} from '@aruku/engine/services/route-plan-builder';
import type { TransitOption } from '@aruku/engine/services/transit-plan-parser';
import { dateTime } from '@aruku/engine/time';

export interface BenchSlot {
  readonly h: number;
  readonly m: number;
}

export const benchSlots: readonly BenchSlot[] = [
  { h: 12, m: 0 },
  { h: 22, m: 0 },
];

/// ふつうの乗換ルートの所要に対する予算（+20%・+50%・+100%）。
export const benchBudgetRatios: readonly number[] = [1.2, 1.5, 2];

/// ふつうの乗換ルートの所要（分）。予算の基準。基準にできる option が無ければ null。
///
/// 出発時刻から乗れない便は基準にしない——乗れない便の所要を基準にすると、予算が
/// 実際より短く出て、どの検索も予算外の縮退から始まる。
export function standardTotalMin(
  options: readonly TransitOption[],
  departureAt: Date,
): number | null {
  let best: number | null = null;
  for (const o of options) {
    if (o.segments.every((s) => s.type === SegmentType.walk)) continue;
    if (firstMissedTransit(o.segments, departureAt) !== null) continue;
    const total = arrivalMinutes(o.segments, departureAt);
    if (best === null || total < best) best = total;
  }
  return best;
}

/// [ratio] 倍の予算を分へ切り上げる。浮動小数の誤差（41×1.2 = 49.199…）で1分ずれない
/// よう、千分の一で丸めてから切り上げる。
export function budgetFor(standardMin: number, ratio: number): number {
  return Math.ceil(Math.round(standardMin * ratio * 1000) / 1000);
}

export function timeValuesFor(
  dayOffset: number,
  slot: BenchSlot,
  budgetMin: number,
): { departure: TimeValue; arrival: TimeValue } {
  const end = slot.h * 60 + slot.m + budgetMin;
  return {
    departure: new TimeValue({ h: slot.h, m: slot.m, dateOffset: dayOffset }),
    arrival: new TimeValue({
      h: Math.floor(end / 60) % 24,
      m: end % 60,
      dateOffset: dayOffset + Math.floor(end / (24 * 60)),
    }),
  };
}

/// [today] の翌日以降で最も近い平日（祝日は見ない）。時刻表は平日と土休日で違うので、
/// 1回の計測の中で曜日を揃える。
export function nextWeekday(today: Date): Date {
  for (let d = 1; ; d++) {
    const day = dateTime(today.getFullYear(), today.getMonth() + 1, today.getDate() + d);
    if (day.getDay() !== 0 && day.getDay() !== 6) return day;
  }
}

export function dayOffsetBetween(today: Date, date: Date): number {
  const start = dateTime(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const end = dateTime(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}
