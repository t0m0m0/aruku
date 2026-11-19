import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RoutePlan,
  RouteSegment,
  SegmentType,
  TimelineNode,
} from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import type { RouteService } from '@aruku/engine/services/route-service';

import { ResultScreen } from '../../../src/features/result/result-screen';
import { locationDenied } from '../../../src/location/location-state';
import { Screen, screenPath } from '../../../src/navigation/screens';
import type { RouteCore } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';
import type { StoreApi } from 'zustand/vanilla';

import { stubViewport } from '../../layout/viewport';

const noon = new Date(2026, 8, 13, 12, 0, 0);

function segment(overrides: Partial<ConstructorParameters<typeof RouteSegment>[0]> = {}) {
  return new RouteSegment({
    type: SegmentType.walk,
    fromName: '出発',
    toName: '渋谷駅',
    minutes: 20,
    km: 1.4,
    kcal: 70,
    ...overrides,
  });
}

function nodes(...places: [string, string][]) {
  return places.map(
    ([place, sub], index) =>
      new TimelineNode({ time: `09:${String(index * 10).padStart(2, '0')}`, place, sub }),
  );
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
    timelineNodes: nodes(['現在地', '出発'], ['渋谷駅', '到着']),
    standardTransit: null,
    timetableSources: [],
    ...overrides,
  };
}

let store: StoreApi<AppStore>;

function setup(initial: Partial<RouteCore> = {}) {
  const navigate = vi.fn();
  const routeService: RouteService = { plan: async () => plan() };
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
  render(<ResultScreen store={store} />);
  return { navigate };
}

describe('撤去した要約', () => {
  it('所要時間・徒歩距離・消費カロリーの3つ並びは出さない', () => {
    setup();

    expect(screen.queryByText('所要時間')).toBeNull();
    expect(screen.queryByText('徒歩距離')).toBeNull();
  });

  it('「制限◯のうち◯で到着」の行は出さない', () => {
    setup({ route: plan({ budgetMin: 90, totalMin: 60 }) });

    expect(screen.queryByText(/のうち/)).toBeNull();
  });

  it('徒歩の割合は出さない', () => {
    setup({ route: plan({ walkRatio: 0.79 }) });

    expect(screen.queryByText(/歩いて移動/)).toBeNull();
    expect(screen.queryByText(/79%/)).toBeNull();
  });
});

describe('補助情報', () => {
  function auxiliary() {
    return screen.getByRole('region', { name: 'このルートについて' });
  }

  it('予算内なら到着の締切と余裕を出す', () => {
    setup({ route: plan({ budgetMin: 90, totalMin: 60 }) });

    expect(within(auxiliary()).getByText('13:30 まで 30分 余裕')).toBeTruthy();
  });

  it('予算を超えていれば余裕は出さない', () => {
    setup({ route: plan({ budgetMin: 60, totalMin: 75 }) });

    expect(within(auxiliary()).queryByText(/余裕/)).toBeNull();
  });

  it('比較・余裕・消費カロリーを1項目ずつのリストにする', () => {
    setup({
      route: plan({
        segments: [segment({ minutes: 33 })],
        standardTransit: { walkMinutes: 10, totalMin: 41 },
      }),
    });

    const items = within(within(auxiliary()).getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('多く歩ける'),
      expect.stringContaining('余裕'),
      expect.stringContaining('消費カロリー'),
    ]);
  });

  it('経路全体の消費カロリーを出す', () => {
    setup({ route: plan({ kcal: 210 }) });

    expect(within(auxiliary()).getByText('消費カロリー 210 kcal')).toBeTruthy();
  });

  it('ふつうの乗換ルートとの比較もここに入る', () => {
    setup({
      route: plan({
        segments: [segment({ minutes: 33 })],
        standardTransit: { walkMinutes: 10, totalMin: 41 },
      }),
    });

    expect(within(auxiliary()).getByText('+23分 多く歩ける')).toBeTruthy();
  });
});

describe('並び（モバイル幅）', () => {
  function precedes(a: Element, b: Element) {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  it('行程・地図・補助情報の順に並ぶ', () => {
    setup();

    const itinerary = screen.getByText('現在地');
    const map = screen.getByTestId('result-map');
    const auxiliary = screen.getByRole('region', { name: 'このルートについて' });

    expect(precedes(itinerary, map)).toBe(true);
    expect(precedes(map, auxiliary)).toBe(true);
  });

  it('予算超過の警告は行程より前に置く', () => {
    setup({ route: plan({ budgetMin: 60, totalMin: 75 }) });

    expect(
      precedes(screen.getByText('制限時間を15分超過しています'), screen.getByText('現在地')),
    ).toBe(true);
  });
});

describe('時刻表の出典', () => {
  function precedes(a: Element, b: Element) {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  const toei = { feedId: 'Toei', fetchedAt: new Date('2026-06-26T19:23:10Z') };

  it('時刻表を使った経路なら、補助情報の後ろに置く', () => {
    setup({ route: plan({ timetableSources: [toei] }) });

    const attribution = screen.getByText('時刻表データについて');
    const auxiliary = screen.getByRole('region', { name: 'このルートについて' });
    expect(precedes(auxiliary, attribution)).toBe(true);
    expect(screen.getByTestId('result-panel').contains(attribution)).toBe(true);
  });

  it('時刻表を使っていなければ出さない', () => {
    setup({ route: plan({ timetableSources: [] }) });

    expect(screen.queryByText('時刻表データについて')).toBeNull();
  });
});

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

describe('ふつうの乗換ルートとの比較', () => {
  const walked = [
    segment({ minutes: 25 }),
    segment({ type: SegmentType.train, minutes: 10, km: 4 }),
    segment({ minutes: 8 }),
  ];

  it('多く歩ける分と、比べた相手の到着・徒歩を出す', () => {
    setup({
      route: plan({ segments: walked, standardTransit: { walkMinutes: 10, totalMin: 41 } }),
    });

    expect(screen.getByText('ふつうの乗換ルートより')).toBeTruthy();
    expect(screen.getByText('+23分 多く歩ける')).toBeTruthy();
    expect(screen.getByText('ふつうの乗換：12:41 着（徒歩 10分）')).toBeTruthy();
  });

  it('差が1時間を超えれば時間で出す', () => {
    setup({
      route: plan({
        segments: [segment({ minutes: 80 })],
        standardTransit: { walkMinutes: 10, totalMin: 41 },
      }),
    });

    expect(screen.getByText('+1時間 10分 多く歩ける')).toBeTruthy();
  });

  it('差が5分に満たなければ出さない', () => {
    setup({
      route: plan({ segments: walked, standardTransit: { walkMinutes: 29, totalMin: 41 } }),
    });

    expect(screen.queryByText('ふつうの乗換ルートより')).toBeNull();
  });

  it('差がちょうど5分なら出す', () => {
    setup({
      route: plan({ segments: walked, standardTransit: { walkMinutes: 28, totalMin: 41 } }),
    });

    expect(screen.getByText('+5分 多く歩ける')).toBeTruthy();
  });

  it('比べる経路が無ければ出さない', () => {
    setup({ route: plan({ segments: walked, standardTransit: null }) });

    expect(screen.queryByText('ふつうの乗換ルートより')).toBeNull();
  });

  it('予算を超えていれば出さない', () => {
    setup({
      route: plan({
        segments: walked,
        budgetMin: 60,
        totalMin: 75,
        standardTransit: { walkMinutes: 10, totalMin: 41 },
      }),
    });

    expect(screen.queryByText('ふつうの乗換ルートより')).toBeNull();
  });
});

describe('区間', () => {
  it('保持している経路をタイムラインへ渡す', () => {
    setup({
      route: plan({
        segments: [
          segment({
            type: SegmentType.train,
            fromName: '渋谷駅',
            toName: '新宿駅',
            line: '山手線',
          }),
        ],
        timelineNodes: nodes(['渋谷駅', '出発'], ['新宿駅', '到着']),
      }),
    });

    expect(screen.getByText('山手線')).toBeTruthy();
    expect(screen.getByText('渋谷駅 → 新宿駅')).toBeTruthy();
  });
});

describe('経路が無いとき', () => {
  it('その旨を出して検索へ戻れる', () => {
    const { navigate } = setup({ route: null });

    expect(screen.getByText('ルートがありません')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '検索に戻る' }));
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.search]);
  });
});

describe('見出し', () => {
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

describe('日を跨いでから見た固定出発の日付', () => {
  it('検索した日ではなく、保持している基準日から数える', () => {
    const searchedOn = new Date(2026, 8, 11, 22, 0, 0);
    const store = createAppStore(
      {
        destination: '渋谷駅',
        dateBasis: searchedOn,
        departure: new TimeValue({ h: 9, m: 0, dateOffset: 1 }),
        arrival: new TimeValue({ h: 11, m: 0, dateOffset: 1 }),
        route: plan(),
      },
      () => searchedOn,
      { request: async () => locationDenied },
      { plan: async () => plan() },
    );
    store.getState().attachNavigator(vi.fn());

    render(<ResultScreen store={store} />);

    const full = new TimeValue({ h: 9, m: 0, dateOffset: 1 }).fullDateLabel(searchedOn);
    expect(screen.getByText(`${full} · 09:00 出発`)).toBeTruthy();
  });
});

describe('地図のプレビュー', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('経路の地図を出す', () => {
    setup();

    expect(screen.getByTestId('result-map')).toBeDefined();
  });

  it('モバイル幅では行程と同じパネルの中に置く', () => {
    stubViewport(false);
    setup();

    expect(screen.getByTestId('result-panel').contains(screen.getByTestId('result-map'))).toBe(
      true,
    );
  });

  it('デスクトップ幅ではパネルの外に1枚だけ置く', () => {
    stubViewport(true);
    setup();

    expect(screen.getAllByTestId('result-map')).toHaveLength(1);
    expect(screen.getByTestId('result-panel').contains(screen.getByTestId('result-map'))).toBe(
      false,
    );
  });
});
