export type Duration = number;

export const durationZero: Duration = 0;

export const seconds = (n: number): Duration => n * 1000;
export const minutes = (n: number): Duration => n * 60 * 1000;

export function dateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

export function differenceInMinutes(a: Date, b: Date): number {
  return Math.trunc((a.getTime() - b.getTime()) / 60000);
}

export function plusMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60000);
}
