import { describe, expect, it } from 'vitest';

import type { PlanArgs } from '@aruku/engine/services/route-service';
import { RouteSearchMetrics } from '@aruku/engine/services/route-diagnostics';

import type { BenchRecord } from '../../src/bench/bench-record';
import { runBench, type BenchDeps } from '../../src/bench/bench-runner';
import type { OdPair } from '../../src/bench/od-pairs';
import { planOf } from './fixtures';

const pair = (id: string): OdPair => ({
  id,
  origin: { name: `${id}発`, lat: 35.6, lng: 139.7 },
  destination: { name: `${id}着`, lat: 35.7, lng: 139.8 },
});

const config = {
  pairs: [pair('p1'), pair('p2')],
  slots: [
    { h: 12, m: 0 },
    { h: 22, m: 0 },
  ],
  ratios: [1.2, 2],
  date: new Date(2026, 9, 27),
  dayOffset: 3,
};

function fakeDeps(o: {
  calibrate?: BenchDeps['calibrate'];
  search?: BenchDeps['search'];
  shouldStop?: () => boolean;
} = {}): BenchDeps & { records: BenchRecord[]; searches: PlanArgs[] } {
  const records: BenchRecord[] = [];
  const searches: PlanArgs[] = [];
  return {
    records,
    searches,
    calibrate: o.calibrate ?? (async () => 40),
    search:
      o.search ??
      (async (args) => {
        searches.push(args);
        const m = new RouteSearchMetrics();
        m.walkA = 10;
        m.walkB = 20;
        return { plan: planOf([], 40, 48), metrics: m };
      }),
    write: (r) => records.push(r),
    shouldStop: o.shouldStop ?? (() => false),
  };
}

describe('runBench', () => {
  it('OD × 時間帯 × 予算を1件ずつ直列に回し、1検索1レコードを書く', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = fakeDeps({
      search: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { plan: planOf([], 40, 48), metrics: new RouteSearchMetrics() };
      },
    });
    await runBench(config, deps);
    expect(deps.records).toHaveLength(8);
    expect(maxInFlight).toEqual(1);
    expect(deps.records.map((r) => `${r.pair}@${r.slot}x${r.ratio}`)).toEqual([
      'p1@12:00x1.2',
      'p1@12:00x2',
      'p1@22:00x1.2',
      'p1@22:00x2',
      'p2@12:00x1.2',
      'p2@12:00x2',
      'p2@22:00x1.2',
      'p2@22:00x2',
    ]);
  });

  it('ふつうの所要は OD × 時間帯ごとに1回だけ測り、予算はその割合', async () => {
    const calibrated: string[] = [];
    const deps = fakeDeps({
      calibrate: async (p, at) => {
        calibrated.push(`${p.id}@${at.getHours()}`);
        return 40;
      },
    });
    await runBench(config, deps);
    expect(calibrated).toEqual(['p1@12', 'p1@22', 'p2@12', 'p2@22']);
    expect(deps.records.map((r) => r.budgetMin).slice(0, 2)).toEqual([48, 80]);
    expect(deps.records[0].standardMin).toEqual(40);
    expect(deps.searches[0].departure.dateOffset).toEqual(3);
    expect(deps.searches[0].origin?.lat).toEqual(35.6);
  });

  it('指標と経路の要約をレコードに入れる', async () => {
    const deps = fakeDeps();
    await runBench(config, deps);
    expect(deps.records[0].metrics?.['walkA']).toEqual(10);
    expect(deps.records[0].metrics?.['walkB']).toEqual(20);
    expect(deps.records[0].plan?.withinBudget).toBe(true);
    expect(deps.records[0].date).toEqual('2026-10-27');
  });

  it('ふつうの所要が測れなければ、その時間帯は検索せずに理由を書く', async () => {
    const deps = fakeDeps({ calibrate: async (p) => (p.id === 'p1' ? null : 40) });
    await runBench(config, deps);
    expect(deps.searches).toHaveLength(4);
    const skipped = deps.records.filter((r) => r.error !== null);
    expect(skipped).toHaveLength(4);
    expect(skipped[0].error).toEqual('no-standard-route');
  });

  it('ふつうの所要を測る照会が失敗すれば、その理由を書いて次へ進む', async () => {
    const deps = fakeDeps({
      calibrate: async (p, at) => {
        if (p.id === 'p1' && at.getHours() === 12) throw new Error('HTTP 503');
        return 40;
      },
    });
    await runBench(config, deps);
    expect(deps.records[0].error).toContain('HTTP 503');
    expect(deps.records[0].error).toMatch(/^calibrate:/);
    expect(deps.searches).toHaveLength(6);
  });

  it('検索が失敗しても記録して次へ進む', async () => {
    let n = 0;
    const deps = fakeDeps({
      search: async () => {
        n++;
        if (n === 1) throw new Error('boom');
        return { plan: planOf([], 40, 48), metrics: new RouteSearchMetrics() };
      },
    });
    await runBench(config, deps);
    expect(deps.records).toHaveLength(8);
    expect(deps.records[0].error).toContain('boom');
    expect(deps.records[0].plan).toBeNull();
    expect(deps.records[1].error).toBeNull();
  });

  it('検索と検索の間に間を置く（最初の検索の前には置かない）', async () => {
    const events: string[] = [];
    const deps = fakeDeps({
      search: async () => {
        events.push('search');
        return { plan: planOf([], 40, 48), metrics: new RouteSearchMetrics() };
      },
    });
    deps.pause = async () => {
      events.push('pause');
    };
    await runBench({ ...config, pairs: [pair('p1')], slots: [{ h: 12, m: 0 }] }, deps);
    expect(events).toEqual(['search', 'pause', 'search']);
  });

  it('止めれば次の検索を起こさない', async () => {
    let stop = false;
    const deps = fakeDeps({ shouldStop: () => stop });
    const search = deps.search;
    deps.search = async (args) => {
      const r = await search(args);
      stop = true;
      return r;
    };
    await runBench(config, deps);
    expect(deps.records).toHaveLength(1);
  });
});
