import { describe, expect, it } from 'vitest';

import {
  isJapaneseHoliday,
  runsSaturdayHolidaySchedule,
} from '../src/timetable-pack/japanese-holidays';

// 内閣府「国民の祝日について」の 2026・2027 年の一覧。
const HOLIDAYS_2026 = [
  20260101, 20260112, 20260211, 20260223, 20260320, 20260429, 20260503, 20260504, 20260505,
  20260506, 20260720, 20260811, 20260921, 20260922, 20260923, 20261012, 20261103, 20261123,
];
const HOLIDAYS_2027 = [
  20270101, 20270111, 20270211, 20270223, 20270321, 20270322, 20270429, 20270503, 20270504,
  20270505, 20270719, 20270811, 20270920, 20270923, 20271011, 20271103, 20271123,
];

const everyDayOf = (year: number): number[] => {
  const days: number[] = [];
  for (
    let d = new Date(Date.UTC(year, 0, 1));
    d.getUTCFullYear() === year;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
  }
  return days;
};

describe('isJapaneseHoliday', () => {
  it.each([
    [2026, HOLIDAYS_2026],
    [2027, HOLIDAYS_2027],
  ])('%i 年の祝日・振替休日・国民の休日をちょうど返す', (year, expected) => {
    expect(everyDayOf(year).filter(isJapaneseHoliday)).toEqual(expected);
  });

  it('春分・秋分を年ごとの計算で求める', () => {
    expect(isJapaneseHoliday(20280320)).toBe(true);
    expect(isJapaneseHoliday(20280922)).toBe(true);
    expect(isJapaneseHoliday(20280923)).toBe(false);
  });
});

describe('runsSaturdayHolidaySchedule', () => {
  it('平日は平日ダイヤ', () => {
    expect(runsSaturdayHolidaySchedule(20261117)).toBe(false);
  });

  it('土曜・日曜は土休日ダイヤ', () => {
    expect(runsSaturdayHolidaySchedule(20261121)).toBe(true);
    expect(runsSaturdayHolidaySchedule(20261122)).toBe(true);
  });

  it('平日の祝日は土休日ダイヤ', () => {
    expect(runsSaturdayHolidaySchedule(20261123)).toBe(true);
  });

  it('年末年始（12/30〜1/3）は平日でも土休日ダイヤ', () => {
    expect(runsSaturdayHolidaySchedule(20261229)).toBe(false);
    expect(runsSaturdayHolidaySchedule(20261230)).toBe(true);
    expect(runsSaturdayHolidaySchedule(20261231)).toBe(true);
    expect(runsSaturdayHolidaySchedule(20270102)).toBe(true);
    expect(runsSaturdayHolidaySchedule(20270104)).toBe(false);
  });
});
