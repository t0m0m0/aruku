// 移植元: lib/features/result/result_screen.dart と result_totals.dart。
//
// 運んでいないもの（いずれも対になる相手が来てから）:
// - タイムラインの描画作り込み（result_timeline.dart）。区間は一覧で出す
// - 区間 CTA と外部地図への handoff（result_leg_cta.dart）。行程＝歩数依存
// - 共有（resultShareText）。外部連携で、経路検索の正しさとは独立

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RoutePlan, RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import type { RouteService } from '@aruku/engine/services/route-service';

import { ResultScreen } from '../../../src/features/result/result-screen';
import { locationDenied } from '../../../src/location/location-state';
import { Screen, screenPath } from '../../../src/navigation/screens';
import type { RouteCore } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';
import type { StoreApi } from 'zustand/vanilla';

const noon = new Date(2026, 8, 13, 12, 0, 0);

function segment(overrides: Partial<ConstructorParameters<typeof RouteSegment>[0]> = {}) {
  return new RouteSegment({
    type: SegmentType.walk,
    fromName: '出発',
    toName: '渋谷駅',
    minutes: 20,
    ...overrides,
  });
}

function plan(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    from: '現在地',
    to: '渋谷駅',
    totalKm: 5.2,
    totalMin: 60,
    budgetMin: 90,
    kcal: 210,
    walkKm: 4.1,
    walkRatio: 0.79,
    segments: [segment()],
    timelineNodes: [],
    ...overrides,
  } as RoutePlan;
}

let store: StoreApi<AppStore>;

function setup(initial: Partial<RouteCore> = {}) {
  const navigate = vi.fn();
  const routeService: RouteService = { plan: (async () => plan()) as RouteService['plan'] };
  store = createAppStore(
    {
      destination: '渋谷駅',
      departure: new TimeValue({ h: 12, m: 0 }),
      arrival: new TimeValue({ h: 13, m: 30 }),
      route: plan(),
      ...initial,
    },
    () => noon,
    { request: async () => locationDenied },
    routeService,
  );
  store.getState().attachNavigator(navigate);
  // 実時刻を使わせない。fixture の日付と今日がたまたま一致している間しか通らない
  // テストになる（fullDateLabel は now を基準に dateOffset を足す）。
  render(<ResultScreen store={store} now={() => noon} />);
  return { navigate };
}

describe('合計', () => {
  it('所要時間・徒歩距離・消費カロリーを出す', () => {
    setup();

    expect(screen.getByText('所要時間')).toBeTruthy();
    expect(screen.getByText('徒歩距離')).toBeTruthy();
    expect(screen.getByText('消費カロリー')).toBeTruthy();
  });

  it('徒歩の割合を百分率で出す', () => {
    setup({ route: plan({ walkRatio: 0.79 }) });

    expect(screen.getByText('距離の 79% を歩いて移動')).toBeTruthy();
  });

  // 予算に対する余裕は、この検索が「歩く時間を最大化できたか」の要約。
  it('予算の残りを余裕として出す', () => {
    setup({ route: plan({ budgetMin: 90, totalMin: 60 }) });

    expect(
      screen.getByText('制限 1時間 30分のうち 1時間 00分 で到着 · 30分 余裕'),
    ).toBeTruthy();
  });

  it('予算を超えていれば超過として出す', () => {
    setup({ route: plan({ budgetMin: 60, totalMin: 75 }) });

    expect(
      screen.getByText('制限 1時間 00分のうち 1時間 15分 で到着 · 15分 超過'),
    ).toBeTruthy();
  });
});

// 時間内に収まらなかったことを黙って出さない。最短経路を出していることまで伝える。
describe('予算の超過', () => {
  it('超過していれば分数を添えて知らせる', () => {
    setup({ route: plan({ budgetMin: 60, totalMin: 75 }) });

    expect(screen.getByText('制限時間を15分超過しています')).toBeTruthy();
    expect(
      screen.getByText('時間内に到達できる経路がないため、最短の経路を表示しています'),
    ).toBeTruthy();
  });

  it('収まっていれば出さない', () => {
    setup({ route: plan({ budgetMin: 90, totalMin: 60 }) });

    expect(screen.queryByText(/超過しています/)).toBeNull();
  });

  it('超過の知らせから条件変更へ行ける', () => {
    const { navigate } = setup({ route: plan({ budgetMin: 60, totalMin: 75 }) });

    fireEvent.click(screen.getByRole('button', { name: '条件を変更' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });
});

describe('区間', () => {
  it('区間を順に出す', () => {
    setup({
      route: plan({
        segments: [
          segment({ fromName: '現在地', toName: '渋谷駅', minutes: 12 }),
          segment({
            type: SegmentType.train,
            fromName: '渋谷駅',
            toName: '新宿駅',
            minutes: 8,
            line: '山手線',
          }),
        ],
      }),
    });

    expect(screen.getByText('現在地 → 渋谷駅')).toBeTruthy();
    expect(screen.getByText('渋谷駅 → 新宿駅')).toBeTruthy();
  });

  it('電車の区間は路線名を出す', () => {
    setup({
      route: plan({
        segments: [
          segment({ type: SegmentType.train, line: '山手線', fromName: 'A', toName: 'B' }),
        ],
      }),
    });

    expect(screen.getByText('山手線')).toBeTruthy();
  });
});

describe('経路が無いとき', () => {
  // ガードが通す以上ここへは経路付きでしか来ないが、来てしまったときに
  // 空の画面を見せない。
  it('その旨を出して検索へ戻れる', () => {
    const { navigate } = setup({ route: null });

    expect(screen.getByText('ルートがありません')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '検索に戻る' }));
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.search]);
  });
});

describe('見出し', () => {
  // dateLabel は home 用で、当日を null・翌日を「明日」にする。結果では実際に検索した
  // 日付を常に出したい（移植元も fullDateLabel を使っている）。
  it('当日でも暦の日付を出す', () => {
    setup({ departure: new TimeValue({ h: 12, m: 0 }) });

    const full = new TimeValue({ h: 12, m: 0 }).fullDateLabel(noon);
    expect(screen.getByText(`${full} · 12:00 出発`)).toBeTruthy();
    expect(screen.queryByText(/^今日 ·/)).toBeNull();
  });

  it('翌日の出発は翌日の日付として出す', () => {
    setup({ departure: new TimeValue({ h: 9, m: 0, dateOffset: 1 }) });

    const full = new TimeValue({ h: 9, m: 0, dateOffset: 1 }).fullDateLabel(noon);
    expect(screen.getByText(`${full} · 09:00 出発`)).toBeTruthy();
  });
});
