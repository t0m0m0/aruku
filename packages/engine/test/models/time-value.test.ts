import { describe, expect, it } from 'vitest';
import { dateOffsetFrom, kMaxDateOffsetDays, TimeValue } from '../../src/models/time-value';
import { dateTime } from '../../src/time';

describe('TimeValue', () => {
  it('dateOffset のデフォルトは 0（今日）', () => {
    const tv = new TimeValue({ h: 9, m: 0 });
    expect(tv.dateOffset).toBe(0);
  });

  it('dateOffset=1 で明日を指定できる', () => {
    const tv = new TimeValue({ h: 9, m: 0, dateOffset: 1 });
    expect(tv.dateOffset).toBe(1);
  });

  it('dateOffset は 1 より大きい任意の日数を指定できる', () => {
    const tv = new TimeValue({ h: 9, m: 0, dateOffset: 30 });
    expect(tv.dateOffset).toBe(30);
  });

  it('dateOffset が負の場合は assert で弾かれる', () => {
    expect(() => new TimeValue({ h: 9, m: 0, dateOffset: -1 })).toThrow(RangeError);
  });

  it('copyWith で dateOffset を変更できる', () => {
    const tv = new TimeValue({ h: 9, m: 0, dateOffset: 0 });
    const tomorrow = tv.copyWith({ dateOffset: 1 });
    expect(tomorrow.dateOffset).toBe(1);
    expect(tomorrow.h).toBe(9);
    expect(tomorrow.m).toBe(0);
  });

  it('copyWith で他フィールドを変更しても dateOffset は引き継がれる', () => {
    const tv = new TimeValue({ h: 9, m: 0, dateOffset: 1 });
    const updated = tv.copyWith({ h: 10 });
    expect(updated.dateOffset).toBe(1);
  });

  it('isNow=true の場合 dateOffset は無視される（値は保持）', () => {
    const tv = new TimeValue({ h: 0, m: 0, isNow: true, dateOffset: 0 });
    expect(tv.isNow).toBe(true);
    expect(tv.dateOffset).toBe(0);
  });
});

describe('TimeValue.fullDateLabel', () => {
  const now = dateTime(2026, 5, 19);

  it('当日（dateOffset=0）は「M月D日 (曜)」', () => {
    const tv = new TimeValue({ h: 8, m: 0, dateOffset: 0 });
    expect(tv.fullDateLabel(now)).toBe('5月19日 (火)');
  });

  it('isNow=true は dateOffset を無視して当日', () => {
    const tv = new TimeValue({ h: 8, m: 0, isNow: true, dateOffset: 3 });
    expect(tv.fullDateLabel(now)).toBe('5月19日 (火)');
  });

  it('翌日（dateOffset=1）は翌日の日付', () => {
    const tv = new TimeValue({ h: 8, m: 0, dateOffset: 1 });
    expect(tv.fullDateLabel(now)).toBe('5月20日 (水)');
  });

  it('月をまたぐ dateOffset も正しく算出', () => {
    const tv = new TimeValue({ h: 9, m: 0, dateOffset: 30 });
    expect(tv.fullDateLabel(now)).toBe('6月18日 (木)');
  });
});

describe('TimeValue.formatBudget', () => {
  it('60分未満は「分」のみ', () => {
    expect(TimeValue.formatBudget(45)).toBe('45分');
  });

  it('60分以上は「時間」と「分」（分は2桁ゼロ埋め）', () => {
    expect(TimeValue.formatBudget(90)).toBe('1時間 30分');
  });

  it('ちょうど時間単位でも分は2桁で表示', () => {
    expect(TimeValue.formatBudget(120)).toBe('2時間 00分');
  });

  it('0以下はプレースホルダ', () => {
    expect(TimeValue.formatBudget(0)).toBe('— ');
  });
});

describe('dateOffsetFrom', () => {
  const now = dateTime(2026, 5, 19, 14, 30);

  it('同じ日は 0', () => {
    expect(dateOffsetFrom({ picked: dateTime(2026, 5, 19), now })).toBe(0);
  });

  it('時刻が残っていても日付だけで数える', () => {
    expect(dateOffsetFrom({ picked: dateTime(2026, 5, 20, 3, 15), now })).toBe(1);
  });

  it('月をまたいでも日数で数える', () => {
    expect(dateOffsetFrom({ picked: dateTime(2026, 6, 18), now })).toBe(30);
  });

  it('上限の日は kMaxDateOffsetDays', () => {
    const last = dateTime(2026, 5, 19 + kMaxDateOffsetDays);
    expect(dateOffsetFrom({ picked: last, now })).toBe(kMaxDateOffsetDays);
  });

  it('過去の日付は 0 へ丸める', () => {
    expect(dateOffsetFrom({ picked: dateTime(2026, 5, 18), now })).toBe(0);
  });

  it('上限より先の日付は kMaxDateOffsetDays へ丸める', () => {
    const beyond = dateTime(2026, 5, 19 + kMaxDateOffsetDays + 5);
    expect(dateOffsetFrom({ picked: beyond, now })).toBe(kMaxDateOffsetDays);
  });

  it('maxOffset を渡すとその上限で丸める', () => {
    const beyond = dateTime(2026, 5, 19 + kMaxDateOffsetDays + 5);
    expect(
      dateOffsetFrom({
        picked: beyond,
        now,
        maxOffset: kMaxDateOffsetDays + 1,
      }),
    ).toBe(kMaxDateOffsetDays + 1);
  });
});
