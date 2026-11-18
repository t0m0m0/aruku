import { dateTime } from '../time';

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

  readonly h: number;

  readonly m: number;

  readonly isNow: boolean;

  readonly dateOffset: number;

  get totalMinutes(): number {
    return this.h * 60 + this.m;
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
    return `${pad2(this.h)}:${pad2(this.m)}`;
  }

  fullDateLabel(now?: Date): string {
    const base = now ?? new Date();
    const offset = this.isNow ? 0 : this.dateOffset;
    const d = dateTime(base.getFullYear(), base.getMonth() + 1, base.getDate() + offset);
    return `${d.getMonth() + 1}月${d.getDate()}日 (${weekdayJp(d)})`;
  }

  static formatBudget(minutes: number): string {
    return formatBudgetText(minutes);
  }

  static formatBudgetJp(minutes: number): string {
    return formatBudgetText(minutes);
  }
}

export const PickerMode = {
  depart: 'depart',
  arrival: 'arrival',
} as const;
export type PickerMode = (typeof PickerMode)[keyof typeof PickerMode];

export const kMaxDateOffsetDays = 90;

export function dateOffsetFrom(args: { picked: Date; now: Date; maxOffset?: number }): number {
  const maxOffset = args.maxOffset ?? kMaxDateOffsetDays;
  const days = calendarDaysBetween({ from: args.now, to: args.picked });
  return Math.min(Math.max(days, 0), maxOffset);
}

export function calendarDaysBetween(args: { from: Date; to: Date }): number {
  const to = Date.UTC(args.to.getFullYear(), args.to.getMonth(), args.to.getDate());
  const from = Date.UTC(args.from.getFullYear(), args.from.getMonth(), args.from.getDate());
  return Math.trunc((to - from) / 86400000);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function weekdayJp(d: Date): string {
  return ['月', '火', '水', '木', '金', '土', '日'][(d.getDay() + 6) % 7];
}

function formatBudgetText(minutes: number): string {
  if (minutes <= 0) return '— ';
  const h = Math.trunc(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}時間 ${pad2(m)}分`;
  return `${m}分`;
}
