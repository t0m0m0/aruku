// mini-tokyo-3d の時刻表は「平日」「土休日」の2種類だけで運行日を持たないので、
// 日付をどちらのダイヤに振るかを祝日法の規則から決める（#511）。
//
// 依存を足さずに規則で書いているのは、祝日の一覧を外から取るとその取得が新しい失敗点になるため。
// 春分・秋分は官報で前年に公示される日で、ここでは 1980〜2099 年に合う近似式で求める。

/** 祝日法の祝日・振替休日・国民の休日か（YYYYMMDD）。 */
export function isJapaneseHoliday(yyyymmdd: number): boolean {
  return holidaysOf(Math.floor(yyyymmdd / 10000)).has(yyyymmdd);
}

/**
 * 土休日ダイヤで走る日か。土日・祝日に加え、年末年始（12/30〜1/3）も土休日ダイヤにする。
 * 年末年始の扱いは事業者ごとに少しずつ違うが、大半がこの期間を土休日ダイヤにしている。
 */
export function runsSaturdayHolidaySchedule(yyyymmdd: number): boolean {
  const weekday = dateOf(yyyymmdd).getUTCDay();
  if (weekday === 0 || weekday === 6) return true;
  const monthDay = yyyymmdd % 10000;
  if (monthDay >= 1230 || monthDay <= 103) return true;
  return isJapaneseHoliday(yyyymmdd);
}

const cache = new Map<number, ReadonlySet<number>>();

function holidaysOf(year: number): ReadonlySet<number> {
  const cached = cache.get(year);
  if (cached !== undefined) return cached;
  const ymd = (month: number, day: number) => year * 10000 + month * 100 + day;
  const nthMonday = (month: number, n: number) => {
    const firstWeekday = dateOf(ymd(month, 1)).getUTCDay();
    return ymd(month, 1 + ((8 - firstWeekday) % 7) + (n - 1) * 7);
  };
  const sinceBase = year - 1980;
  const leapDays = Math.floor(sinceBase / 4);
  const named = [
    ymd(1, 1),
    nthMonday(1, 2),
    ymd(2, 11),
    ymd(2, 23),
    ymd(3, Math.floor(20.8431 + 0.242194 * sinceBase - leapDays)),
    ymd(4, 29),
    ymd(5, 3),
    ymd(5, 4),
    ymd(5, 5),
    nthMonday(7, 3),
    ymd(8, 11),
    nthMonday(9, 3),
    ymd(9, Math.floor(23.2488 + 0.242194 * sinceBase - leapDays)),
    nthMonday(10, 2),
    ymd(11, 3),
    ymd(11, 23),
  ];
  const holidays = new Set(named);
  // 国民の休日: 前後を祝日に挟まれた平日。
  for (const day of named) {
    const between = shift(day, 1);
    if (holidays.has(shift(day, 2)) && !holidays.has(between) && dateOf(between).getUTCDay() !== 0) {
      holidays.add(between);
    }
  }
  // 振替休日: 日曜の祝日の後で、最初の祝日でない日。
  for (const day of named) {
    if (dateOf(day).getUTCDay() !== 0) continue;
    let substitute = shift(day, 1);
    while (holidays.has(substitute)) substitute = shift(substitute, 1);
    holidays.add(substitute);
  }
  cache.set(year, holidays);
  return holidays;
}

function dateOf(yyyymmdd: number): Date {
  return new Date(
    Date.UTC(Math.floor(yyyymmdd / 10000), (Math.floor(yyyymmdd / 100) % 100) - 1, yyyymmdd % 100),
  );
}

function shift(yyyymmdd: number, days: number): number {
  const d = dateOf(yyyymmdd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
