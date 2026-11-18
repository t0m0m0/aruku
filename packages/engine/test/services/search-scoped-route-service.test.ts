import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { RoutePlan, type RouteSegment } from '../../src/models/route-plan';
import { TimeValue } from '../../src/models/time-value';
import { CancellationToken, SearchCanceledException } from '../../src/services/cancellation';
import {
  RouteException,
  SearchScopedRouteService,
  type PlanArgs,
  type RouteService,
  type SearchEngine,
} from '../../src/services/route-service';
import { deferred, type Deferred } from '../support/deferred';
import { expectThrowsA } from '../support/expect';

const plan = new RoutePlan({
  from: 'A',
  to: 'B',
  totalKm: 1,
  totalMin: 1,
  budgetMin: 1,
  kcal: 1,
  walkKm: 1,
  walkRatio: 1,
  segments: [] as RouteSegment[],
  timelineNodes: [],
});

class FakeEngine implements SearchEngine {
  constructor(private readonly options: { gate?: Deferred<void>; error?: Error } = {}) {}

  closed = 0;
  planned = 0;

  async plan(_args: PlanArgs): Promise<RoutePlan> {
    this.planned++;
    if (this.options.gate !== undefined) await this.options.gate.promise;
    if (this.options.error !== undefined) throw this.options.error;
    return plan;
  }

  close(): void {
    this.closed++;
  }
}

const run = (service: RouteService, cancellation?: CancellationToken): Promise<RoutePlan> =>
  service.plan({
    destination: 'B',
    destinationLatLng: new GeoPoint(35.0, 139.0),
    departure: new TimeValue({ h: 9, m: 0 }),
    arrival: new TimeValue({ h: 12, m: 0 }),
    origin: new GeoPoint(35.1, 139.1),
    cancellation,
  });

const pumpEventQueue = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SearchScopedRouteService', () => {
  it('plan ごとにエンジンを組み立てる', async () => {
    const engines: FakeEngine[] = [];
    const service = new SearchScopedRouteService(() => {
      const engine = new FakeEngine();
      engines.push(engine);
      return engine;
    });

    await run(service);
    await run(service);

    expect(engines).toHaveLength(2);
    expect(engines.every((e) => e.planned === 1)).toBe(true);
  });

  it('正常終了でもエンジンを閉じる', async () => {
    const engine = new FakeEngine();
    const service = new SearchScopedRouteService(() => engine);

    await run(service);
    expect(engine.closed).toBe(1);
  });

  it('例外で終わってもエンジンを閉じる', async () => {
    const engine = new FakeEngine({ error: new RouteException('ZERO_RESULTS') });
    const service = new SearchScopedRouteService(() => engine);

    await expectThrowsA(() => run(service), RouteException);
    expect(engine.closed).toBe(1);
  });

  it('キャンセルすると plan の完了を待たずにエンジンを閉じる', async () => {
    const gate = deferred<void>();
    const engine = new FakeEngine({ gate });
    const service = new SearchScopedRouteService(() => engine);
    const cancellation = new CancellationToken();

    const future = run(service, cancellation);
    await pumpEventQueue();
    expect(engine.closed, 'キャンセル前に閉じてはいけない').toBe(0);

    cancellation.cancel();
    expect(engine.closed, 'in-flight のうちに通信を切る').toBe(1);

    gate.complete();
    await expectThrowsA(() => future, SearchCanceledException);
  });

  it('キャンセル後に湧いた通信エラーは SearchCanceledException へ揃える', async () => {
    const gate = deferred<void>();
    const engine = new FakeEngine({ gate, error: new RouteException('X') });
    const service = new SearchScopedRouteService(() => engine);
    const cancellation = new CancellationToken();

    const future = run(service, cancellation);
    await pumpEventQueue();
    cancellation.cancel();
    gate.complete();

    await expectThrowsA(() => future, SearchCanceledException);
  });

  it('キャンセルしなければ通信エラーはそのまま伝播する', async () => {
    const engine = new FakeEngine({ error: new RouteException('TIMEOUT') });
    const service = new SearchScopedRouteService(() => engine);

    const e = await expectThrowsA(() => run(service, new CancellationToken()), RouteException);
    expect(e.status).toBe('TIMEOUT');
  });

  it('エンジンにキャンセルトークンを渡す', async () => {
    let seen: CancellationToken | null = null;
    const cancellation = new CancellationToken();
    const service = new SearchScopedRouteService((token) => {
      seen = token;
      return new FakeEngine();
    });

    await run(service, cancellation);
    expect(seen).toBe(cancellation);
  });
});
