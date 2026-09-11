// 移植元: lib/core/navigation/app_router.dart の `redirect`。

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { TimeValue } from '@aruku/engine/models/time-value';
import { RoutePhase } from '@aruku/engine/services/route-service';
import type { RoutePlan } from '@aruku/engine/models/route-plan';

import { resolveRedirect } from '../../src/navigation/guard';
import {
  RouteErrorKind,
  routeFreshness,
  type RouteCore,
} from '../../src/state/app-state';

const now = new Date(2026, 8, 11, 12, 0, 0);

// 経路の中身はガードの関心事ではない（null かどうかだけを見る）。
const someRoute = {} as RoutePlan;

function core(overrides: Partial<RouteCore> = {}): RouteCore {
  return {
    destination: '東京駅',
    destinationLatLng: new GeoPoint(35.681, 139.767),
    origin: null,
    originLatLng: null,
    departure: new TimeValue({ h: 9, m: 0 }),
    arrival: new TimeValue({ h: 10, m: 0 }),
    route: null,
    routeAsOf: null,
    routeErrorKind: null,
    routePhase: null,
    ...overrides,
  };
}

describe('未知の location', () => {
  it('登録の無いパスは home へ跳ね返す', () => {
    expect(resolveRedirect('/home/nav', core(), now)).toBe('/home');
  });

  it('ルートのパスは home へ跳ね返す', () => {
    expect(resolveRedirect('/', core(), now)).toBe('/home');
  });
});

describe('表示前提データを欠く deep link', () => {
  it('route が無ければ result を表示しない', () => {
    expect(resolveRedirect('/home/result', core(), now)).toBe('/home');
  });

  it('routePhase が無ければ loading を表示しない', () => {
    expect(resolveRedirect('/home/loading', core(), now)).toBe('/home');
  });

  it('routeErrorKind が無ければ error を表示しない', () => {
    expect(resolveRedirect('/home/error', core(), now)).toBe('/home');
  });

  it('前提を持たない画面は素通しする', () => {
    for (const path of [
      '/home',
      '/home/settings',
      '/home/search',
      '/home/search-origin',
    ]) {
      expect(resolveRedirect(path, core(), now)).toBeNull();
    }
  });
});

describe('表示前提データが揃っていれば素通しする', () => {
  it('route があれば result を表示する', () => {
    expect(
      resolveRedirect('/home/result', core({ route: someRoute }), now),
    ).toBeNull();
  });

  it('routePhase があれば loading を表示する', () => {
    expect(
      resolveRedirect(
        '/home/loading',
        core({ routePhase: RoutePhase.routing }),
        now,
      ),
    ).toBeNull();
  });

  it('routeErrorKind があれば error を表示する', () => {
    expect(
      resolveRedirect(
        '/home/error',
        core({ routeErrorKind: RouteErrorKind.timeout }),
        now,
      ),
    ).toBeNull();
  });
});

describe('isNow 経路の失効 (#264)', () => {
  const withRoute = (ageMs: number): RouteCore =>
    core({ route: someRoute, routeAsOf: new Date(now.getTime() - ageMs) });

  it('猶予内なら result を表示する', () => {
    expect(
      resolveRedirect('/home/result', withRoute(routeFreshness - 1), now),
    ).toBeNull();
  });

  it('猶予を使い切ったら result を表示しない', () => {
    // 境界は「以上」。移植元 isNowRouteExpired の `>=` と揃える。
    expect(resolveRedirect('/home/result', withRoute(routeFreshness), now)).toBe(
      '/home',
    );
  });

  it('固定出発（routeAsOf が無い）経路は時間経過で失効しない', () => {
    expect(
      resolveRedirect('/home/result', core({ route: someRoute }), now),
    ).toBeNull();
  });
});
