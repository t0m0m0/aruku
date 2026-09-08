// 移植元: lib/core/models/time_value.dart

import { notImplemented } from '../not-implemented';

export interface TimeValueInit {
  h: number;
  m: number;
  isNow?: boolean;
  dateOffset?: number;
}

export class TimeValue {
  constructor(init: TimeValueInit) {
    if ((init.dateOffset ?? 0) < 0) {
      throw new RangeError('dateOffset must be >= 0');
    }
    this.h = init.h;
    this.m = init.m;
    this.isNow = init.isNow ?? false;
    this.dateOffset = init.dateOffset ?? 0;
  }

  /// 0–23
  readonly h: number;

  /// 0–59 (typically multiples of 5)
  readonly m: number;

  /// Departure side: "current time" — auto-derived.
  readonly isNow: boolean;

  /// 今日からの日数オフセット。0 = 今日, 1 = 明日, n = n日後。
  /// isNow=true のときは無視される。
  readonly dateOffset: number;

  get totalMinutes(): number {
    return notImplemented('TimeValue.totalMinutes');
  }

  copyWith(patch: Partial<TimeValueInit> = {}): TimeValue {
    return new TimeValue({
      h: patch.h ?? this.h,
      m: patch.m ?? this.m,
      isNow: patch.isNow ?? this.isNow,
      dateOffset: patch.dateOffset ?? this.dateOffset,
    });
  }

  format(): string {
    return notImplemented('TimeValue.format');
  }

  /// この出発／到着が指す絶対日付のラベル「M月D日 (曜)」。当日でも省略せず必ず返す。
  fullDateLabel(now?: Date): string {
    return notImplemented(`TimeValue.fullDateLabel(${String(now)})`);
  }

  /// ホーム画面に出す日付ラベル。当日・「今すぐ」は表示しない（null）。
  dateLabel(now?: Date): string | null {
    return notImplemented(`TimeValue.dateLabel(${String(now)})`);
  }

  static formatBudget(minutes: number): string {
    return notImplemented(`TimeValue.formatBudget(${minutes})`);
  }

  static formatBudgetJp(minutes: number): string {
    return notImplemented(`TimeValue.formatBudgetJp(${minutes})`);
  }
}

export const PickerMode = {
  depart: 'depart',
  arrival: 'arrival',
} as const;
export type PickerMode = (typeof PickerMode)[keyof typeof PickerMode];

/// 出発・到着に指定できる先の上限（今日からの日数）。
export const kMaxDateOffsetDays = 90;

/// カレンダーが返す絶対日付を [TimeValue.dateOffset]（今日からの日数）へ直す。
export function dateOffsetFrom(args: {
  picked: Date;
  now: Date;
  maxOffset?: number;
}): number {
  return notImplemented(`dateOffsetFrom(${String(args.picked)})`);
}

/// [from] から [to] までのカレンダー日数。過去なら負。
export function calendarDaysBetween(args: { from: Date; to: Date }): number {
  return notImplemented(`calendarDaysBetween(${String(args.from)})`);
}
