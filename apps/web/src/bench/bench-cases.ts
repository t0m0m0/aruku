import { TimeValue } from '@aruku/engine/models/time-value';
import type { TransitOption } from '@aruku/engine/services/transit-plan-parser';
import { standardTransitSummary } from '@aruku/engine/services/transit-route-service';
import { dateTime } from '@aruku/engine/time';

export interface BenchSlot {
  readonly h: number;
  readonly m: number;
}

export const benchSlots: readonly BenchSlot[] = [
  { h: 12, m: 0 },
  { h: 22, m: 0 },
];

export const benchBudgetRatios: readonly number[] = [1.2, 1.5, 2];

export function standardTotalMin(
  options: readonly TransitOption[],
  departureAt: Date,
): number | null {
  return standardTransitSummary(options, departureAt)?.totalMin ?? null;
}

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
