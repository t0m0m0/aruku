// 移植元: lib/features/picker/（date_time_picker_sheet.dart / desktop_time_field.dart /
// time_field_input.dart）。widget test は運ばず、ここで押さえるのは「欄の操作が
// 状態へどう届くか」と「欄が示す選べる範囲」。
//
// ホイールと月グリッドを自作せず native の `<input type="time" / "date">` に載せた
// ため、移植元にあった「ホイールの下限を initState で1回だけ読む」といった、
// 自作 UI の都合に由来する検証は消えている。

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { StoreApi } from 'zustand/vanilla';

import { PickerMode, TimeValue, kMaxDateOffsetDays } from '@aruku/engine/models/time-value';
import { absoluteMinutes, budgetMinutes } from '@aruku/engine/services/route-plan-builder';

import { TimeField } from '../../../src/features/picker/time-field';
import { ja } from '../../../src/i18n/ja';
import type { RouteCore } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';

const noon = new Date(2026, 8, 11, 12, 0, 0);

let store: StoreApi<AppStore>;

function setup(
  initial: Partial<RouteCore>,
  mode: PickerMode = PickerMode.depart,
  clock: () => Date = () => noon,
) {
  store = createAppStore(initial, clock);
  const label =
    mode === PickerMode.depart ? ja.homeDepartureLabel : ja.homeArrivalLabel;
  render(<TimeField store={store} mode={mode} label={label} now={clock} />);
  return {
    time: screen.getByLabelText(ja.timeFieldTime(label)) as HTMLInputElement,
    date: screen.getByLabelText(ja.timeFieldDate(label)) as HTMLInputElement,
  };
}

function setupBoth(initial: Partial<RouteCore>, clock: () => Date) {
  store = createAppStore(initial, clock);
  render(
    <>
      <TimeField
        store={store}
        mode={PickerMode.depart}
        label={ja.homeDepartureLabel}
        now={clock}
      />
      <TimeField
        store={store}
        mode={PickerMode.arrival}
        label={ja.homeArrivalLabel}
        now={clock}
      />
    </>,
  );
  const field = (label: string, kind: '時刻' | '日付') =>
    screen.getByLabelText(
      kind === '時刻' ? ja.timeFieldTime(label) : ja.timeFieldDate(label),
    ) as HTMLInputElement;
  return {
    departTime: field(ja.homeDepartureLabel, '時刻'),
    departDate: field(ja.homeDepartureLabel, '日付'),
    arrivalTime: field(ja.homeArrivalLabel, '時刻'),
    arrivalDate: field(ja.homeArrivalLabel, '日付'),
  };
}

const at = (h: number, m: number, dateOffset = 0) =>
  new TimeValue({ h, m, dateOffset });

afterEach(cleanup);

/// 打ち終えた欄を離れる。移植元の「焦点が外れて初めて確定する」に当たる。
function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('時刻の入力', () => {
  it('入れた時刻が状態へ確定する', () => {
    const { time } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    type(time, '13:30');

    expect(store.getState().departure.format()).toBe('13:30');
  });

  it('打ちかけの値は確定しない', () => {
    // 時・分は1桁ずつ来る。`23:58` と打つ途中の `02:58` をそのつど確定すると、
    // 過去時刻の切り上げが割り込んで打った値ごと差し替わる（実ブラウザで確認）。
    const { time } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    fireEvent.change(time, { target: { value: '02:58' } });

    expect(store.getState().departure.format()).toBe('13:00');
    expect(time.value).toBe('02:58');
  });

  it('空のまま離れた欄は元の値へ戻る', () => {
    // native の time 入力は打ちかけを空文字で返す。そのまま確定すると、
    // 消しただけの操作が 00:00 の指定になる。
    const { time } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    type(time, '');

    expect(store.getState().departure.format()).toBe('13:00');
    expect(time.value).toBe('13:00');
  });

  it('今日の過ぎた時刻は現在時刻へ寄せ、欄にもそれを出す', () => {
    // min 属性は案内であって保証ではない。過去のまま照会へ行くと結果が意味を失う。
    const { time } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    type(time, '09:00');

    expect(store.getState().departure.format()).toBe('12:00');
    // 寄せた先を欄へ書き戻す。打った値を残すと、欄と状態が食い違ったまま検索へ行く。
    expect(time.value).toBe('12:00');
  });

  it('到着に出発より前を入れると、出発のあとへ寄る', () => {
    const { time } = setup(
      { departure: at(13, 0), arrival: at(14, 0) },
      PickerMode.arrival,
    );

    type(time, '10:00');

    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(1);
  });
});

describe('↑↓ の刻み', () => {
  it('5分ずつ動かす', () => {
    const { time } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    fireEvent.keyDown(time, { key: 'ArrowUp' });

    expect(store.getState().departure.format()).toBe('13:05');
  });

  it('日をまたぐ刻みは日付も一緒に動かす', () => {
    // native の ↑↓ は同日内で折り返す。23:58 の5分後が「同じ日の 00:03」になると、
    // 翌日のままの到着との予算が 25 時間近くへ膨らむ。
    const { time, date } = setup(
      { departure: at(23, 58), arrival: at(23, 59) },
      PickerMode.depart,
    );

    fireEvent.keyDown(time, { key: 'ArrowUp' });

    expect(store.getState().departure.format()).toBe('00:03');
    expect(store.getState().departure.dateOffset).toBe(1);
    expect(date.value).toBe('2026-09-12');
  });

  it('選べる範囲の外へは動かさない', () => {
    // 今日の 00:02 から5分戻すと昨日になる。時刻だけ折り返して日付を据え置くと、
    // 5分前のつもりが同日 23:57＝24時間近く後ろへ飛ぶ。
    const { time } = setup(
      { departure: at(0, 2, 0), arrival: at(1, 0, 0) },
      PickerMode.depart,
      () => new Date(2026, 8, 11, 0, 0, 0),
    );

    fireEvent.keyDown(time, { key: 'ArrowDown' });

    expect(store.getState().departure.format()).toBe('00:02');
    expect(store.getState().departure.dateOffset).toBe(0);
  });
});

describe('日付の入力', () => {
  it('選んだ日が今日からの日数へ直る', () => {
    const { date } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    type(date, '2026-09-13');

    expect(store.getState().departure.dateOffset).toBe(2);
    expect(store.getState().departure.format()).toBe('13:00');
  });

  it('出発は今日から上限の日まで選べる', () => {
    const { date } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    expect(date.min).toBe('2026-09-11');
    expect(date.max).toBe('2026-12-10'); // 90 日後
  });

  it('到着は出発の日より前を出さない', () => {
    const { date } = setup(
      { departure: at(13, 0, 3), arrival: at(14, 0, 3) },
      PickerMode.arrival,
    );

    expect(date.min).toBe('2026-09-14');
  });

  it('押し出された到着は上限の外でもカレンダーに残る', () => {
    // 定数で切ると、いま指している日がカレンダーから消え、開いて確定しただけで
    // 値が動く。
    const { date } = setup(
      {
        departure: at(23, 0, kMaxDateOffsetDays),
        arrival: at(0, 30, kMaxDateOffsetDays + 1),
      },
      PickerMode.arrival,
    );

    expect(date.value).toBe('2026-12-11');
    expect(date.max).toBe('2026-12-11');
  });
});

describe('開いたまま日を跨いだとき', () => {
  it('確定の前に、出発も到着も新しい今日で数え直す', () => {
    // dateOffset は state に基準日を持たず、常に「今日」から数えられる。跨いだ
    // ぶんを詰めずに確定すると、触っていない側が黙って1日先を指す。
    let clock = new Date(2026, 8, 11, 23, 59, 0);
    const { time } = setup(
      { departure: at(23, 59, 0), arrival: at(0, 30, 1) },
      PickerMode.depart,
      () => clock,
    );

    clock = new Date(2026, 8, 12, 0, 1, 0);
    type(time, '00:05');

    // 詰め直さないと、触っていない到着が 13 日を指したまま残る。
    expect(store.getState().departure.format()).toBe('00:05');
    expect(store.getState().departure.dateOffset).toBe(0);
    expect(store.getState().arrival.dateOffset).toBe(0);
    // 引き上げられた出発を追って到着も動く（予算幅を保つ）。時計の値そのものは
    // 引き上げ幅で決まるので、ここで押さえるのは「出発より後にある」こと。
    expect(
      absoluteMinutes(store.getState().arrival) -
        absoluteMinutes(store.getState().departure),
    ).toBeGreaterThan(0);
  });
});


// Codex レビュー（PR #399）。いずれも「開いたまま時間が経つ」経路で、単発の操作では
// 現れない。
describe('開いたまま時間が経ったとき', () => {
  it('同じ日でも「今すぐ」の出発は現在時刻へ追従する', () => {
    // 09:00 に開いて正午に到着 13:00 を選ぶと、出発は 09:00 のまま予算 4 時間として
    // 記録される。startSearch は出発だけを正午へ更新して予算を保つので、選んだ
    // 13:00 ではなく 16:00 着を探しに行く。
    let clock = new Date(2026, 8, 11, 9, 0, 0);
    const { time } = setup(
      { departure: new TimeValue({ h: 9, m: 0, isNow: true }), arrival: at(10, 0) },
      PickerMode.arrival,
      () => clock,
    );

    clock = new Date(2026, 8, 11, 12, 0, 0);
    type(time, '13:00');

    expect(store.getState().departure.format()).toBe('12:00');
    expect(store.getState().departure.isNow).toBe(true);
    expect(store.getState().arrival.format()).toBe('13:00');
    expect(budgetMinutes(store.getState().departure, store.getState().arrival)).toBe(60);
  });

  it('値の変わらない blur は「今すぐ」を固定しない', () => {
    // タブで通り抜けただけ・native のピッカーを何も選ばずに閉じただけでも blur は
    // 来る。そこで確定すると isNow が落ち、検索は blur した時刻で凍る。
    const clock = new Date(2026, 8, 11, 9, 0, 0);
    const { time } = setup(
      { departure: new TimeValue({ h: 9, m: 0, isNow: true }), arrival: at(10, 0) },
      PickerMode.depart,
      () => clock,
    );

    fireEvent.blur(time);

    expect(store.getState().departure.isNow).toBe(true);
  });

  it('日を跨いだ詰め直しは、もう片方の欄にも効く', () => {
    // 欄ごとに基準日を持つと、片方を確定したときにもう片方の基準が古いまま残る。
    // その欄は詰め直し済みの offset を昨日基準で描き、確定すると同じ1日をもう一度
    // 適用する。
    let clock = new Date(2026, 8, 11, 23, 59, 0);
    const fields = setupBoth(
      { departure: at(23, 59, 0), arrival: at(0, 30, 1) },
      () => clock,
    );

    clock = new Date(2026, 8, 12, 0, 1, 0);
    type(fields.departTime, '00:05');

    // 到着の欄も新しい今日で描き直る（12日の 00:32。13日ではない）。
    expect(fields.arrivalDate.value).toBe('2026-09-12');

    type(fields.arrivalTime, '01:00');

    expect(store.getState().arrival.dateOffset).toBe(0);
    expect(store.getState().arrival.format()).toBe('01:00');
  });

  it('選び終える前に過ぎてしまった日は、今日へ丸めない', () => {
    // 23:55 に日付を選んで閉じたのが 00:05 だと、選んだ絶対日付はもう昨日。
    // dateOffsetFrom は負を 0 へ丸めるので、そのまま確定すると詰め直した予定を
    // 引きずり降ろす（ここでは 13 日 12:00 着が 13 日 10:01 着へ潰れる）。
    let clock = new Date(2026, 8, 11, 23, 55, 0);
    const { date } = setup(
      { departure: at(10, 0, 2), arrival: at(12, 0, 2) },
      PickerMode.arrival,
      () => clock,
    );

    fireEvent.change(date, { target: { value: '2026-09-11' } });
    clock = new Date(2026, 8, 12, 0, 5, 0);
    fireEvent.blur(date);

    // 詰め直しだけが効いて、選んだ日は捨てる（13 日を指したまま）。
    expect(store.getState().arrival.format()).toBe('12:00');
    expect(store.getState().arrival.dateOffset).toBe(1);
    expect(date.value).toBe('2026-09-13');
  });
});

// Codex レビュー（PR #399）。時刻→日付と、並んでいる順に触ったときの経路。
describe('時刻を打ってから日付を選ぶ', () => {
  it('打った時刻が、選んだ日付と一緒に確定する', () => {
    // 正午に「明日 09:00 発」と決めたい。時刻を先に打つと、日付欄へ移る blur が
    // それだけを確定し、今日の過去時刻として 12:00 へ切り上げてしまう——続く日付の
    // 確定は切り上げ後の値を読むので、明日 12:00 発になる。
    const { time, date } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    fireEvent.change(time, { target: { value: '09:00' } });
    fireEvent.blur(time, { relatedTarget: date });
    fireEvent.change(date, { target: { value: '2026-09-12' } });
    fireEvent.blur(date);

    expect(store.getState().departure.format()).toBe('09:00');
    expect(store.getState().departure.dateOffset).toBe(1);
  });

  it('日付を選んでから時刻を打っても同じ', () => {
    const { time, date } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    fireEvent.change(date, { target: { value: '2026-09-12' } });
    fireEvent.blur(date, { relatedTarget: time });
    fireEvent.change(time, { target: { value: '09:00' } });
    fireEvent.blur(time);

    expect(store.getState().departure.format()).toBe('09:00');
    expect(store.getState().departure.dateOffset).toBe(1);
  });

  it('日付へ移らずに欄を出たら、今日の過去時刻として切り上げる', () => {
    // 日付を変える気が無いなら、過去のまま照会へ渡さない従来の保証が要る。
    const { time } = setup({ departure: at(13, 0), arrival: at(14, 0) });

    fireEvent.change(time, { target: { value: '09:00' } });
    fireEvent.blur(time);

    expect(store.getState().departure.format()).toBe('12:00');
  });
});
