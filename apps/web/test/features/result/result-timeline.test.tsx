// 移植元: lib/features/result/result_timeline.dart。
//
// journey 進捗（#305 の _LegState done/current/upcoming と _LegStateBadge）は運んでいない。
// JourneyProgress は歩数同期に依存し、#386 が Web で作らないと決めた側——移植元で言えば
// journey==null の _LegState.none だけが残った形になる。
//
// ノードと区間カードの対応は route-plan-builder が組み立てる（「segments と timelineNodes の
// 1:1 対応を保つ」）。ここが押さえるのは、その対応を描画側が取り違えないこと。

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

/// 徒歩 → 電車。route-plan-builder が出す最小形（出発・乗車駅・到着の 3 ノード）。
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

  // 空の補足でも要素だけは出す、にすると縦の隙間（gap）が 1 つぶん余る。空文字は
  // textContent に現れないので、行の有無は要素数で見るしかない。
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

describe('ノードと区間カードの対応', () => {
  it('ノードの直下に区間カードを1枚ずつ置く', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    expect(within(steps()[0]).getByText('徒歩')).toBeTruthy();
    expect(within(steps()[1]).getByText('山手線')).toBeTruthy();
  });

  // 到着ノードは「その先の区間」を持たない。ノードは常に区間より 1 つ以上多いので、
  // 末尾で区間を使い切った状態になる。
  it('到着ノードには区間カードを置かない', () => {
    render(<ResultTimeline route={walkThenRide()} />);

    const last = within(steps()[2]);
    expect(last.getByText('渋谷駅')).toBeTruthy();
    expect(last.queryByText('徒歩')).toBeNull();
    expect(last.queryByText('山手線')).toBeNull();
  });

  // 直結乗換（電車→電車で間に徒歩が無い）は「着」「発」の 2 行に割れ、着行は
  // cardBelow:false でカードを挟まない。ここを読み落とすと着行が次の区間カードを
  // 食い、以降のカードが 1 つずつ手前のノードへずれる。
  it('カードを伴わないノードは区間カードを消費しない', () => {
    render(
      <ResultTimeline
        route={plan(
          [ride({ line: '山手線', toName: '代々木駅' }), ride({ line: '中央線', fromName: '代々木駅' })],
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

describe('徒歩の区間カード', () => {
  it('徒歩と距離・カロリーを出す', () => {
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
    expect(screen.getByText('+128 kcal')).toBeTruthy();
  });

  // 徒歩レッグの km/kcal は経路生成が必ず埋めるが、型は null を許す。移植元は `!` で
  // 落としていた——描画で落とす価値は無い。
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

describe('乗り物の区間カード', () => {
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

  // [RouteSegment.fare] を埋める経路は現状どこにも無く、この分岐は常に不発
  // （docs/spec/route-optimization.md §4 #71）。別の運賃ソースを得たときに
  // パーサの配線だけで点灯できるよう、器ごと運んでいる。
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

// 数字と単位は字送りが違うため別のスパンに割れている（移植元 _durationParts）。
// getByText は要素の直下テキストしか見ないので、割れた並びを 1 本の文字列としては
// 拾えない——読み手に届く形は連結後なので、そちらで見る。この見方は「割った断片が
// 隙間も入れ替わりも無く並ぶ」ことまで押さえる。
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
    return steps()[0].textContent ?? '';
  }

  it('60分未満はそのまま分で出す', () => {
    expect(renderWithMinutes(12)).toContain('12分');
  });

  // 移植元は 60 分以上を n時間mm分 へ分解し、分を 2 桁でゼロ詰めする。
  it('60分以上は時間と分に割る', () => {
    expect(renderWithMinutes(65)).toContain('1時間05分');
  });

  it('ちょうど60分は0分を省かない', () => {
    expect(renderWithMinutes(60)).toContain('1時間00分');
  });
});
