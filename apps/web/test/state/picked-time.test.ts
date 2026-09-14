// 移植元: lib/core/state/app_state.dart の `applyPickedTime` / `rebaseDates`。
//
// 守りたい不変条件は「出発 < 到着」がどの入口からも壊れないこと。UI 側の min/max は
// 案内であって保証ではない——キー入力・オートフィル・古いブラウザは範囲外を渡す。

import { describe, expect, it } from 'vitest';

import { TimeValue, PickerMode, kMaxDateOffsetDays } from '@aruku/engine/models/time-value';
import { budgetMinutes, absoluteMinutes } from '@aruku/engine/services/route-plan-builder';

import { resolveRedirect } from '../../src/navigation/guard';
import { Screen, screenPath } from '../../src/navigation/screens';
import { createAppStore } from '../../src/state/store';

import type { RoutePlan } from '@aruku/engine/models/route-plan';

function storeWith(departure: TimeValue, arrival: TimeValue) {
  return createAppStore({ departure, arrival });
}

const at = (h: number, m: number, dateOffset = 0) =>
  new TimeValue({ h, m, dateOffset });

describe('applyPickedTime（出発）', () => {
  it('予算が保たれる範囲なら到着は動かさない', () => {
    const store = storeWith(at(10, 0), at(12, 0));

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.depart, h: 9, m: 0, dateOffset: 0 });

    expect(store.getState().departure.format()).toBe('09:00');
    expect(store.getState().arrival.format()).toBe('12:00');
  });

  it('到着を追い越す出発は、変更前の予算を保って到着を押し出す', () => {
    const store = storeWith(at(10, 0), at(11, 0));

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.depart, h: 14, m: 0, dateOffset: 0 });

    expect(store.getState().arrival.format()).toBe('15:00');
    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(60);
  });

  it('押し出された到着は翌日へ繰り上がる', () => {
    const store = storeWith(at(10, 0), at(11, 0));

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.depart, h: 23, m: 30, dateOffset: 0 });

    expect(store.getState().arrival.format()).toBe('00:30');
    expect(store.getState().arrival.dateOffset).toBe(1);
  });

  it('押し出された到着は選べる上限の外にも出る', () => {
    // 上限の日の終わりから出発すると、到着は 91 日目に立つ。ここを上限で
    // 丸めると「出発 < 到着」が壊れる（丸めるのはカレンダーが出す範囲の側）。
    const store = storeWith(
      at(23, 0, kMaxDateOffsetDays),
      at(23, 59, kMaxDateOffsetDays),
    );

    store.getState().applyPickedTime({
      mode: PickerMode.depart,
      h: 23,
      m: 59,
      dateOffset: kMaxDateOffsetDays,
    });

    expect(store.getState().arrival.dateOffset).toBe(kMaxDateOffsetDays + 1);
    expect(
      absoluteMinutes(store.getState().arrival) -
        absoluteMinutes(store.getState().departure),
    ).toBeGreaterThan(0);
  });

  it('時刻を選ぶと「今すぐ」が解ける', () => {
    const store = storeWith(new TimeValue({ h: 10, m: 0, isNow: true }), at(11, 0));

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.depart, h: 10, m: 30, dateOffset: 0 });

    expect(store.getState().departure.isNow).toBe(false);
  });
});

describe('applyPickedTime（到着）', () => {
  it('出発より後ならそのまま入る', () => {
    const store = storeWith(at(10, 0), at(11, 0));

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.arrival, h: 13, m: 0, dateOffset: 0 });

    expect(store.getState().arrival.format()).toBe('13:00');
    expect(store.getState().departure.format()).toBe('10:00');
  });

  it('出発より前の到着は出発 + 最小ギャップへ寄せる', () => {
    const store = storeWith(at(10, 0), at(11, 0));

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.arrival, h: 8, m: 0, dateOffset: 0 });

    expect(
      absoluteMinutes(store.getState().arrival) -
        absoluteMinutes(store.getState().departure),
    ).toBe(1);
    // 出発は動かさない。到着を選んだのに出発が動くと、寄せた先がまた動く。
    expect(store.getState().departure.format()).toBe('10:00');
  });
});

describe('rebaseDates', () => {
  it('跨いだ日数だけ詰めて、指している絶対日付と予算幅を保つ', () => {
    const store = storeWith(at(10, 0, 2), at(11, 0, 2));

    store.getState().rebaseDates(1, new Date(2026, 8, 14, 9, 0));

    expect(store.getState().departure.dateOffset).toBe(1);
    expect(store.getState().departure.format()).toBe('10:00');
    expect(store.getState().arrival.dateOffset).toBe(1);
    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(60);
  });

  it('過ぎ去った日を指していた出発は現在時刻へ引き上げる', () => {
    const store = storeWith(at(10, 0), at(11, 0));

    store.getState().rebaseDates(1, new Date(2026, 8, 14, 9, 30));

    expect(store.getState().departure.format()).toBe('09:30');
    expect(store.getState().departure.dateOffset).toBe(0);
    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(60);
  });

  it('日を跨がなくても、今日の過ぎた時刻は現在時刻へ引き上げる', () => {
    const store = storeWith(at(9, 0), at(10, 0));

    store.getState().rebaseDates(0, new Date(2026, 8, 14, 9, 30));

    expect(store.getState().departure.format()).toBe('09:30');
    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(60);
  });

  it('「今すぐ」は現在時刻へ追従し、今すぐのまま残る', () => {
    const store = storeWith(new TimeValue({ h: 8, m: 0, isNow: true }), at(9, 0));

    store.getState().rebaseDates(0, new Date(2026, 8, 14, 9, 30));

    expect(store.getState().departure.isNow).toBe(true);
    expect(store.getState().departure.format()).toBe('09:30');
    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(60);
  });
});

// Codex レビュー（PR #399）。web では「戻る」で降りた result が**進む**の先に残る。
describe('時刻を変えたときの保持中の経路', () => {
  it('捨てる。進むで戻れる result が、新しい出発の下に古い経路を出すため', () => {
    const store = createAppStore({
      departure: at(10, 0),
      arrival: at(11, 0),
      route: {} as RoutePlan,
      routeAsOf: new Date(2026, 8, 11, 10, 0),
    });

    store
      .getState()
      .applyPickedTime({ mode: PickerMode.depart, h: 15, m: 0, dateOffset: 0 });

    expect(store.getState().route).toBeNull();
    expect(store.getState().routeAsOf).toBeNull();
    // ガードは route の有無で result を通す。捨てれば進むが home へ跳ね返る。
    expect(
      resolveRedirect(screenPath[Screen.result], store.getState(), new Date()),
    ).toBe(screenPath[Screen.home]);
  });
});
