export function isJapaneseHoliday(yyyymmdd: number): boolean {
  return holidaysOf(Math.floor(yyyymmdd / 10000)).has(yyyymmdd);
}

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
  for (const day of named) {
    const between = shift(day, 1);
    if (
      holidays.has(shift(day, 2)) &&
      !holidays.has(between) &&
      dateOf(between).getUTCDay() !== 0
    ) {
      holidays.add(between);
    }
  }
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
