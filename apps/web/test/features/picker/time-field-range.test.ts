// 移植元: lib/features/picker/time_field_input.dart と desktop_time_field.dart の
// 値域の算出。
//
// `parseTimeInput`（入力文字列の解釈）は運んでいない。`<input type="time">` は
// 不完全な入力を空文字で返すので、任意の文字列から時と分を切り出す規則が要らない。

import { describe, expect, it } from 'vitest';

import { TimeValue, PickerMode, kMaxDateOffsetDays } from '@aruku/engine/models/time-value';

import {
  clampDepartureMinutes,
  firstSelectableOffset,
  lastSelectableOffset,
  stepTotalMinutes,
} from '../../../src/features/picker/time-field-range';

describe('stepTotalMinutes', () => {
  it('日をまたぐ刻みは、またいだ日数を返す', () => {
    // 時刻だけ折り返して日付を据え置くと、23:58 の5分後が「同日の 00:03」になり、
    // 翌日のままの到着との予算が 1 時間から 25 時間近くへ膨らむ。
    expect(stepTotalMinutes(23 * 60 + 58, 5)).toEqual({
      totalMinutes: 3,
      dayDelta: 1,
    });
  });

  it('前へまたぐ刻みは日数が負になる', () => {
    expect(stepTotalMinutes(2, -5)).toEqual({
      totalMinutes: 23 * 60 + 57,
      dayDelta: -1,
    });
  });

  it('同日に収まる刻みは日を動かさない', () => {
    expect(stepTotalMinutes(10 * 60, 5)).toEqual({
      totalMinutes: 10 * 60 + 5,
      dayDelta: 0,
    });
  });
});

describe('clampDepartureMinutes', () => {
  it('今日の過ぎた時刻は現在時刻へ寄せる', () => {
    expect(
      clampDepartureMinutes({
        totalMinutes: 9 * 60,
        dateOffset: 0,
        nowMinutes: 14 * 60,
      }),
    ).toBe(14 * 60);
  });

  it('先の日付の同じ時刻は過去ではない', () => {
    expect(
      clampDepartureMinutes({
        totalMinutes: 9 * 60,
        dateOffset: 1,
        nowMinutes: 14 * 60,
      }),
    ).toBe(9 * 60);
  });
});

describe('firstSelectableOffset', () => {
  const departAt = (h: number, m: number, dateOffset = 0) =>
    new TimeValue({ h, m, dateOffset });

  it('出発は今日から選べる', () => {
    expect(firstSelectableOffset(PickerMode.depart, departAt(23, 59, 3))).toBe(0);
  });

  it('到着は出発の日から選べる', () => {
    expect(firstSelectableOffset(PickerMode.arrival, departAt(10, 0, 2))).toBe(2);
  });

  it('出発 + 最小ギャップが日をまたぐなら、到着の下限も翌日になる', () => {
    // 23:59 出発の到着は最速でも翌日 00:00。同じ日を出すと、選んだ日と
    // applyPickedTime が確定する日が食い違う。
    expect(firstSelectableOffset(PickerMode.arrival, departAt(23, 59))).toBe(1);
  });

  it('「今すぐ」出発は保持値の日で数える', () => {
    // 実時刻へ寄せるのは確定時の rebaseDates の仕事。下限だけ先に寄せると、
    // 欄が出している値と選べる日が食い違う。
    const now = new TimeValue({ h: 23, m: 59, isNow: true });
    expect(firstSelectableOffset(PickerMode.arrival, now)).toBe(1);
  });
});

describe('lastSelectableOffset', () => {
  const dep = new TimeValue({ h: 10, m: 0 });

  it('既定は選べる上限の日', () => {
    expect(
      lastSelectableOffset(PickerMode.depart, dep, new TimeValue({ h: 10, m: 0 })),
    ).toBe(kMaxDateOffsetDays);
  });

  it('押し出された到着が上限の外に居るなら、その日まで出す', () => {
    // 定数で切るとその日がカレンダーから消え、開いて確定しただけで値が動く。
    const pushedOut = new TimeValue({ h: 0, m: 30, dateOffset: kMaxDateOffsetDays + 1 });
    expect(lastSelectableOffset(PickerMode.arrival, dep, pushedOut)).toBe(
      kMaxDateOffsetDays + 1,
    );
  });

  it('下限が上限を越えるなら、下限まで出す', () => {
    const lateDeparture = new TimeValue({
      h: 23,
      m: 59,
      dateOffset: kMaxDateOffsetDays,
    });
    expect(
      lastSelectableOffset(PickerMode.arrival, lateDeparture, new TimeValue({ h: 0, m: 0 })),
    ).toBe(kMaxDateOffsetDays + 1);
  });
});
