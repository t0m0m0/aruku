import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  RoutePlan,
  RouteSegment,
  SegmentType,
  TimelineNode,
} from '@aruku/engine/models/route-plan';

import { ResultTimeline } from '../../../src/features/result/result-timeline';

function node(init: ConstructorParameters<typeof TimelineNode>[0]) {
  return new TimelineNode(init);
}

function walk(overrides: Partial<ConstructorParameters<typeof RouteSegment>[0]> = {}) {
  return new RouteSegment({
    type: SegmentType.walk,
    fromName: '新宿駅',
    toName: '代々木駅',
    minutes: 12,
    km: 0.9,
    kcal: 45,
    ...overrides,
  });
}

function ride(overrides: Partial<ConstructorParameters<typeof RouteSegment>[0]> = {}) {
  return new RouteSegment({
    type: SegmentType.train,
    fromName: '代々木駅',
    toName: '渋谷駅',
    minutes: 8,
    line: '山手線',
    ...overrides,
  });
}

function plan(segments: RouteSegment[], timelineNodes: TimelineNode[]): RoutePlan {
  return new RoutePlan({
    from: '新宿駅',
    to: '渋谷駅',
    totalKm: 5.2,
    totalMin: 60,
    budgetMin: 90,
    kcal: 210,
    walkKm: 4.1,
    walkRatio: 0.79,
    segments,
    timelineNodes,
  });
}

function walkThenRide() {
  return plan(
    [walk(), ride()],
    [
      node({ time: '09:00', place: '新宿駅', sub: '出発' }),
      node({ time: '09:12', place: '代々木駅', sub: '山手線 渋谷方面' }),
      node({ time: '09:20', place: '渋谷駅', sub: '到着 · 制限内 ✓' }),
    ],
  );
}

function steps() {
  return screen.getAllByRole('listitem');
}

describe('ノードの並び', () => {
  it('時刻・地点・補足を順に出す', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    const first = within(steps()[0]);
    expect(first.getByText('09:00')).toBeTruthy();
    expect(first.getByText('新宿駅')).toBeTruthy();
    expect(first.getByText('出発')).toBeTruthy();
  });

  it('補足が空のノードでは補足の行を作らない', () => {
    render(
      <ResultTimeline
        route={plan(
          [ride()],
          [
            node({ time: '09:00', place: '新宿駅', sub: '' }),
            node({ time: '09:08', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );

    expect(screen.getByText('新宿駅').parentElement?.childElementCount).toBe(1);
    expect(screen.getByText('渋谷駅').parentElement?.childElementCount).toBe(2);
  });
});

describe('ノードと区間の対応', () => {
  it('ノードの直下に区間を1枚ずつ置く', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    expect(within(steps()[0]).getByText('徒歩')).toBeTruthy();
    expect(within(steps()[1]).getByText('山手線')).toBeTruthy();
  });

  it('到着ノードには区間を置かない', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    const last = within(steps()[2]);
    expect(last.getByText('渋谷駅')).toBeTruthy();
    expect(last.queryByText('徒歩')).toBeNull();
    expect(last.queryByText('山手線')).toBeNull();
  });

  it('区間を伴わないノードは区間を消費しない', () => {
    render(
      <ResultTimeline
        route={plan(
          [
            ride({ line: '山手線', toName: '代々木駅' }),
            ride({ line: '中央線', fromName: '代々木駅' }),
          ],
          [
            node({ time: '09:00', place: '新宿駅', sub: '出発' }),
            node({ time: '09:05', place: '代々木駅', sub: '', cardBelow: false }),
            node({ time: '09:07', place: '代々木駅', sub: '中央線 東京方面' }),
            node({ time: '09:20', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );

    expect(within(steps()[0]).getByText('山手線')).toBeTruthy();
    expect(within(steps()[1]).queryByText('中央線')).toBeNull();
    expect(within(steps()[2]).getByText('中央線')).toBeTruthy();
  });
});

describe('徒歩の区間', () => {
  it('徒歩と距離を出し、カロリーは出さない', () => {
    render(
      <ResultTimeline
        route={plan(
          [walk({ km: 3.25, kcal: 128 })],
          [
            node({ time: '09:00', place: '新宿駅', sub: '出発' }),
            node({ time: '09:12', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );

    expect(screen.getByText('徒歩')).toBeTruthy();
    expect(screen.getByText('3.3km')).toBeTruthy();
    expect(screen.queryByText(/kcal/)).toBeNull();
  });

  it('距離が欠けていても描ける', () => {
    render(
      <ResultTimeline
        route={plan(
          [walk({ km: null, kcal: null })],
          [
            node({ time: '09:00', place: '新宿駅', sub: '出発' }),
            node({ time: '09:12', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );

    expect(screen.getByText('徒歩')).toBeTruthy();
    expect(screen.queryByText(/km$/)).toBeNull();
    expect(screen.queryByText(/kcal/)).toBeNull();
  });
});

describe('乗り物の区間', () => {
  it('路線名と乗降駅を出す', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    expect(screen.getByText('山手線')).toBeTruthy();
    expect(screen.getByText('代々木駅 → 渋谷駅')).toBeTruthy();
  });

  it.each([
    [SegmentType.train, '電車'],
    [SegmentType.bus, 'バス'],
  ])('路線名が無ければ %s の既定ラベルへ落とす', (type, label) => {
    render(
      <ResultTimeline
        route={plan(
          [ride({ type, line: null })],
          [
            node({ time: '09:00', place: '新宿駅', sub: '出発' }),
            node({ time: '09:08', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );

    expect(screen.getByText(label)).toBeTruthy();
  });

  it('運賃があれば添える', () => {
    render(
      <ResultTimeline
        route={plan(
          [ride({ fare: 170 })],
          [
            node({ time: '09:00', place: '新宿駅', sub: '出発' }),
            node({ time: '09:08', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );

    expect(screen.getByText('¥170')).toBeTruthy();
  });

  it('運賃が無ければ出さない', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    expect(screen.queryByText(/¥/)).toBeNull();
  });
});

describe('区間の所要時間', () => {
  function renderWithMinutes(minutes: number) {
    render(
      <ResultTimeline
        route={plan(
          [walk({ minutes })],
          [
            node({ time: '09:00', place: '新宿駅', sub: '出発' }),
            node({ time: '10:00', place: '渋谷駅', sub: '到着' }),
          ],
        )}
      />,
    );
    return steps()[0].textContent;
  }

  it('60分未満はそのまま分で出す', () => {
    expect(renderWithMinutes(12)).toContain('12分');
  });

  it('60分以上は時間と分に割る', () => {
    expect(renderWithMinutes(65)).toContain('1時間05分');
  });

  it('ちょうど60分は0分を省かない', () => {
    expect(renderWithMinutes(60)).toContain('1時間00分');
  });
});

describe('区間を Google マップで開くリンク', () => {
  it('区間ごとに、その区間の行き先を名指ししたリンクを置く', () => {
    render(<ResultTimeline route={walkThenRide()} />);
    screen.getByRole('link', { name: '代々木駅までの徒歩をGoogleマップで開く' });
    screen.getByRole('link', { name: '渋谷駅までの山手線をGoogleマップで開く' });
  });

  it('徒歩区間は徒歩ルート、乗り物の区間は乗換案内を開く', () => {
    render(<ResultTimeline route={walkThenRide()} />);
    const [walkLink, rideLink] = screen.getAllByRole('link');
    expect(new URL(walkLink.getAttribute('href')!).searchParams.get('travelmode')).toBe('walking');
    expect(new URL(rideLink.getAttribute('href')!).searchParams.get('travelmode')).toBe('transit');
  });

  it('別タブで開き、開いた先からこの画面を触らせない', () => {
    render(<ResultTimeline route={walkThenRide()} />);
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('行き先が決まらない区間にはリンクを置かない', () => {
    const route = new RoutePlan({
      ...walkThenRide(),
      to: '',
      segments: [walk(), ride({ toName: '' })],
    });
    render(<ResultTimeline route={route} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('行き先名が空の区間は名前を省いて読み上げる', () => {
    const route = new RoutePlan({
      ...walkThenRide(),
      segments: [walk(), ride({ toName: '' })],
    });
    render(<ResultTimeline route={route} />);
    screen.getByRole('link', { name: '山手線をGoogleマップで開く' });
  });
});
