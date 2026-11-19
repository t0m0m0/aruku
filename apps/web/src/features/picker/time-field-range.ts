import { PickerMode, TimeValue, kMaxDateOffsetDays } from '@aruku/engine/models/time-value';

import { kMinBudgetMinutes } from '../../state/app-state';

export const kTimeStepMinutes = 5;

const minutesPerDay = 24 * 60;

export function stepTotalMinutes(
  totalMinutes: number,
  step: number,
): { totalMinutes: number; dayDelta: number } {
  const moved = totalMinutes + step;
  const dayDelta = Math.floor(moved / minutesPerDay);
  return { totalMinutes: moved - dayDelta * minutesPerDay, dayDelta };
}

export function clampDepartureMinutes(args: {
  totalMinutes: number;
  dateOffset: number;
  nowMinutes: number;
}): number {
  return args.dateOffset === 0 && args.totalMinutes < args.nowMinutes
    ? args.nowMinutes
    : args.totalMinutes;
}

export function firstSelectableOffset(mode: PickerMode, departure: TimeValue): number {
  if (mode === PickerMode.depart) return 0;
  const offset = departure.isNow ? 0 : departure.dateOffset;
  const carry = Math.floor((departure.totalMinutes + kMinBudgetMinutes) / minutesPerDay);
  return offset + carry;
}

export function lastSelectableOffset(
  mode: PickerMode,
  departure: TimeValue,
  current: TimeValue,
): number {
  return Math.max(kMaxDateOffsetDays, firstSelectableOffset(mode, departure), current.dateOffset);
}
