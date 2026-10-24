// 厳密走査の A/B 計測（#462）の入口。`npm run dev` の間だけ /bench.html で開ける。
//
// `vite build` の入力は index.html だけなので、この入口は本番の配信物に入らない
// （test/build/production-bundle.test.ts が確かめる）。App Check は本番と同じく
// src/firebase/app-check.ts を通す——開発時はデバッグトークンで交換される。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RouteSearchMetrics } from '@aruku/engine/services/route-diagnostics';
import { TransitApiClient } from '@aruku/engine/services/transit-api-client';
import { parseGuidancePlan } from '@aruku/engine/services/transit-plan-parser';

import { appConfig } from '../config';
import { initializeFirebaseAppCheck } from '../firebase/app-check';
import { createRouteService, createTransitClient } from '../search/route-service';
import {
  benchBudgetRatios,
  benchSlots,
  dayOffsetBetween,
  standardTotalMin,
} from './bench-cases';
import { ridesToVerify, runVerify } from './ab-verify';
import { runBench } from './bench-runner';
import type { BenchRecord } from './bench-record';
import { BenchScreen, type BenchHooks, type VerifyHooks } from './bench-screen';
import { benchPairs } from './od-pairs';

import '../theme/base.css';

if (!import.meta.env.DEV) throw new Error('ベンチ画面は開発時だけ使う');

const appCheck = initializeFirebaseAppCheck();

let lastMetrics: RouteSearchMetrics | null = null;
const routeService = createRouteService({
  transitBaseUrl: appConfig.transitApiBaseUrl,
  proxyBaseUrl: appConfig.proxyBaseUrl,
  appCheck,
  exactWalkMaxAb: true,
  onMetrics: (m) => {
    lastMetrics = m;
  },
});

const transit = new TransitApiClient({
  transitClient: createTransitClient(),
  transitBaseUrl: appConfig.transitApiBaseUrl,
});

/// 検索と検索の間の待ち。1検索で十数本を叩くので、直列でも間を置かないと上流
/// （Transit API・プロキシのレート制限 docs/ops/exact-ab-bench.md）に連続で当たり続ける。
const pauseBetweenSearchesMs = 3000;

const total = benchPairs.length * benchSlots.length * benchBudgetRatios.length;

const run = (date: Date, hooks: BenchHooks): Promise<void> =>
  runBench(
    {
      pairs: benchPairs,
      slots: benchSlots,
      ratios: benchBudgetRatios,
      date,
      dayOffset: dayOffsetBetween(new Date(), date),
    },
    {
      ...hooks,
      calibrate: async (pair, departureAt) =>
        standardTotalMin(
          parseGuidancePlan(
            await transit.fetchGuidanceAt(
              new GeoPoint(pair.origin.lat, pair.origin.lng),
              new GeoPoint(pair.destination.lat, pair.destination.lng),
              departureAt,
            ),
          ),
          departureAt,
        ),
      pause: () => new Promise((resolve) => setTimeout(resolve, pauseBetweenSearchesMs)),
      search: async (args) => {
        lastMetrics = null;
        const plan = await routeService.plan(args);
        return { plan, metrics: lastMetrics };
      },
    },
  );

/// 照合する経路の上限。issue の「数本」に合わせ、Transit API への往復も抑える。
const verifyLimit = 10;

const verify = (records: BenchRecord[], hooks: VerifyHooks): Promise<void> =>
  runVerify(ridesToVerify(records, verifyLimit), {
    ...hooks,
    fetchOptions: async (from, to, at) =>
      parseGuidancePlan(await transit.fetchGuidanceAt(from, to, at)),
  });

const container = document.getElementById('root');
if (container === null) throw new Error('#root が bench.html に見つからない');

createRoot(container).render(
  <StrictMode>
    <BenchScreen now={() => new Date()} total={total} run={run} verify={verify} />
  </StrictMode>,
);
