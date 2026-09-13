// ルート表とガードが実際に繋がっているかの検証。
//
// guard.test.ts は純粋関数としての判定を見る。そちらが緑でも loader に配線され
// ていなければ何も守らないので、ここは「ルート表を通ったときに跳ね返るか」を見る。

import { describe, expect, it } from 'vitest';

import type { RouteObject } from 'react-router';
import type { RoutePlan } from '@aruku/engine/models/route-plan';

import { appRoutes } from '../../src/navigation/router';
import { screenPath } from '../../src/navigation/screens';
import { createAppStore } from '../../src/state/store';

const now = new Date(2026, 8, 11, 12, 0, 0);
const someRoute = {} as RoutePlan;

function loaderFor(routes: RouteObject[], path: string) {
  const route = routes.find((r) => r.path === path);
  if (route?.loader === undefined) throw new Error(`no loader for ${path}`);
  return route.loader as (args: { request: Request }) => null;
}

function run(routes: RouteObject[], path: string): Response | null {
  try {
    loaderFor(routes, path)({ request: new Request(`https://app.test${path}`) });
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe('ルート表', () => {
  it('画面のパスをすべて含む', () => {
    const paths = appRoutes(createAppStore()).map((r) => r.path);
    for (const path of Object.values(screenPath)) {
      expect(paths).toContain(path);
    }
  });

  it('未知の location を受ける catch-all を持つ', () => {
    expect(appRoutes(createAppStore()).map((r) => r.path)).toContain('*');
  });
});

describe('loader に配線されたガード', () => {
  it('表示前提データを欠く画面は home へ跳ね返す', () => {
    const routes = appRoutes(createAppStore(), () => now);

    const response = run(routes, screenPath.result);

    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe(screenPath.home);
  });

  it('跳ね返しは履歴を積まずに差し替える', () => {
    // 積むと、弾かれた URL が履歴に残る。home へ着いた後の最初の「戻る」が
    // home を再表示するだけになり、アプリを離れられない。
    const routes = appRoutes(createAppStore(), () => now);

    const response = run(routes, screenPath.result);

    expect(response?.headers.get('X-Remix-Replace')).toBe('true');
  });

  it('表示前提データが揃っていれば素通しする', () => {
    const routes = appRoutes(createAppStore({ route: someRoute }), () => now);

    expect(run(routes, screenPath.result)).toBeNull();
  });

  it('ルートのパスは home へ跳ね返す', () => {
    const response = run(appRoutes(createAppStore(), () => now), '/');

    expect(response?.headers.get('Location')).toBe(screenPath.home);
  });
});
