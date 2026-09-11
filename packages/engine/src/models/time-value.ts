// 移植元: lib/core/models/time_value.dart

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

  /// この出発／到着が指す絶対日付のラベル「M月D日 (曜)」。当日でも省略せず必ず返す。
  /// isNow=true は「今すぐ」なので当日扱い（dateOffset は無視）。経路結果画面ヘッダーの
  /// ように、実際に検索した日付を常に明示したい箇所で使う（[dateLabel] は当日を null に
  /// するため不可）。
  fullDateLabel(now?: Date): string {
    const base = now ?? new Date();
    const offset = this.isNow ? 0 : this.dateOffset;
    const d = dateTime(
      base.getFullYear(),
      base.getMonth() + 1,
      base.getDate() + offset,
    );
    return `${d.getMonth() + 1}月${d.getDate()}日 (${weekdayJp(d)})`;
  }

  /// ホーム画面に出す日付ラベル。当日・「今すぐ」は表示しない（null）。
  /// 翌日は「明日」、それ以降は「M/D(曜)」。
  dateLabel(now?: Date): string | null {
    if (this.isNow || this.dateOffset === 0) return null;
    if (this.dateOffset === 1) return '明日';
    const base = now ?? new Date();
    const d = dateTime(
      base.getFullYear(),
      base.getMonth() + 1,
      base.getDate() + this.dateOffset,
    );
    return `${d.getMonth() + 1}/${d.getDate()}(${weekdayJp(d)})`;
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

/// 出発・到着に指定できる先の上限（今日からの日数）。
export const kMaxDateOffsetDays = 90;

/// カレンダーが返す絶対日付を [TimeValue.dateOffset]（今日からの日数）へ直す。
///
/// 入口ごとに書かない。丸めを落とすと範囲外が [TimeValue] のコンストラクタの
/// `dateOffset >= 0` 検査まで素通りする。[maxOffset] を渡せるのは、押し出された到着が
/// [kMaxDateOffsetDays] を越えて存在し得るため——出した範囲で数え直さないと、表示した
/// 日を選んだだけで別の日へ丸められる。
export function dateOffsetFrom(args: {
  picked: Date;
  now: Date;
  maxOffset?: number;
}): number {
  const maxOffset = args.maxOffset ?? kMaxDateOffsetDays;
  const days = calendarDaysBetween({ from: args.now, to: args.picked });
  return Math.min(Math.max(days, 0), maxOffset);
}

/// [from] から [to] までのカレンダー日数。過去なら負。
///
/// UTC へ置き換えるのは、ローカルのままだと夏時間を挟む1日が23時間で切り捨てが 0 を
/// 返すため。[dateOffsetFrom] と分けるのは「選べる範囲」と「経過日数」が別の量だから
/// ——上限を被せると放置された状態が範囲内に見える。
export function calendarDaysBetween(args: { from: Date; to: Date }): number {
  const to = Date.UTC(
    args.to.getFullYear(),
    args.to.getMonth(),
    args.to.getDate(),
  );
  const from = Date.UTC(
    args.from.getFullYear(),
    args.from.getMonth(),
    args.from.getDate(),
  );
  return Math.trunc((to - from) / 86400000);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/// 月曜始まり。Dart の `DateTime.weekday`（月=1）と JavaScript の `Date.getDay()`
/// （日=0）で週の起点が違うので、添字を作るところで吸収する。
function weekdayJp(d: Date): string {
  return ['月', '火', '水', '木', '金', '土', '日'][(d.getDay() + 6) % 7];
}

/// 予算（分）を「H時間 MM分」「M分」へ。0 以下は未確定として全角ダッシュ。
function formatBudgetText(minutes: number): string {
  if (minutes <= 0) return '— ';
  const h = Math.trunc(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}時間 ${pad2(m)}分`;
  return `${m}分`;
}
