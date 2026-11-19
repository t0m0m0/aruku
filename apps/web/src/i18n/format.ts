import { ja } from './ja';

export function pickerDateLabel(date: Date, dateOffset: number): string {
  const lead = dateOffset === 0 ? ja.dateToday : dateOffset === 1 ? ja.dateTomorrow : null;
  return lead === null ? todayDateLabel(date) : `${lead} · ${todayDateLabel(date)}`;
}

export function todayDateLabel(now: Date): string {
  const weekday = ja.weekdays[(now.getDay() + 6) % 7];
  return `${now.getMonth() + 1}月${now.getDate()}日 (${weekday})`;
}

const jstOffsetMs = 9 * 3600 * 1000;

export function fetchedAtLabel(at: Date): string {
  const jst = new Date(at.getTime() + jstOffsetMs);
  const minute = String(jst.getUTCMinutes()).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ` +
    `${jst.getUTCHours()}:${minute}`
  );
}
