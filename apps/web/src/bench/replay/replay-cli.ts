import { appendFileSync } from 'node:fs';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RouteSearchMetrics } from '@aruku/engine/services/route-diagnostics';
import {
  SearchScopedRouteService,
  searchDeadlineBudget,
  transitRequestTimeout,
} from '@aruku/engine/services/route-service';
import { SearchDeadline } from '@aruku/engine/services/search-deadline';
import { TransitApiClient } from '@aruku/engine/services/transit-api-client';
import { parseGuidancePlan } from '@aruku/engine/services/transit-plan-parser';
import { TransitRouteService } from '@aruku/engine/services/transit-route-service';

import { defaultTransitApiBaseUrl } from '../../config';
import { standardTotalMin } from '../bench-cases';
import { runBench } from '../bench-runner';
import { replayPairs } from '../od-pairs';
import { localExactWalkMax, localRideDepartures } from './exact-replay';
import { parseReplayArgs, replayUsage, type ReplayArgs } from './replay-args';
import { isInitialQuery, ReplaySession, timedOutStatus, type ReplayEntry } from './replay-client';
import type { ReplayRecord } from './replay-report';
import { loadStore, saveStore } from './replay-store';

const proxyOrigin = 'https://proxy.invalid';

const recordPauseMs = 3000;

async function fetchLive(url: URL): Promise<ReplayEntry> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(transitRequestTimeout),
    });
    const body = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { status: res.status, body, ms: elapsed() };
  } catch {
    return { status: timedOutStatus, body: '', ms: elapsed() };
  }
}

export async function runReplay(args: ReplayArgs): Promise<number> {
  const store = loadStore(args.store);
  let current: { origin: GeoPoint; goal: GeoPoint } | null = null;
  const { urlLog } = args;
  const session = new ReplaySession({
    mode: args.mode,
    store,
    fetchLive,
    proxyOrigin,
    refetchLimitMs: args.refetchLimitMs,
    exactWalkMax:
      args.exactPacks === null
        ? undefined
        : localExactWalkMax({ packDir: args.exactPacks, now: () => args.date }),
    exactDelayMs: args.exactDelayMs,
    rideDepartures:
      args.ridePacks === null
        ? undefined
        : localRideDepartures({ packDir: args.ridePacks, now: () => args.date }),
    rideDelayMs: args.rideDelayMs,
    isInitial: (url) => current !== null && isInitialQuery(url, current.origin, current.goal),
    onRequest:
      urlLog === null
        ? undefined
        : (url) => {
            const stack = (new Error().stack ?? '')
              .split('\n')
              .slice(2, 14)
              .map((l) => l.trim());
            appendFileSync(
              urlLog,
              `${JSON.stringify({ t: Math.round(performance.now()), url: url.href, stack })}\n`,
            );
          },
  });
  let seenMisses = 0;
  let seenLimitHits = 0;

  await runBench(
    {
      pairs: replayPairs.filter((p) => args.pairs === null || args.pairs.test(p.id)),
      slots: args.slots,
      ratios: args.ratios,
      date: args.date,
      now: () => args.date,
    },
    {
      calibrate: async (pair, departureAt) => {
        const origin = new GeoPoint(pair.origin.lat, pair.origin.lng);
        const goal = new GeoPoint(pair.destination.lat, pair.destination.lng);
        current = { origin, goal };
        const client = session.client();
        try {
          const api = new TransitApiClient({
            transitClient: client,
            transitBaseUrl: defaultTransitApiBaseUrl,
          });
          return standardTotalMin(
            parseGuidancePlan(
              await api.fetchGuidanceAt(origin, goal, departureAt, { purpose: 'initial' }),
            ),
            departureAt,
          );
        } finally {
          client.close();
        }
      },
      search: async (planArgs) => {
        let metrics: RouteSearchMetrics | null = null;
        const service = new SearchScopedRouteService(
          (cancellation) =>
            new TransitRouteService({
              transitClient: session.client(),
              proxyClient: session.client(),
              transitBaseUrl: defaultTransitApiBaseUrl,
              proxyBaseUrl: proxyOrigin,
              cancellation,
              clock: () => args.date,
              exactWalkMax: args.exactPacks !== null,
              rideDepartures: args.ridePacks !== null,
              verifyRideDepartures: args.rideVerify,
              deadline: new SearchDeadline(searchDeadlineBudget),
              onMetrics: (m) => {
                metrics = m;
              },
            }),
        );
        const plan = await service.plan(planArgs);
        return { plan, metrics };
      },
      write: (record) => {
        const row: ReplayRecord = {
          label: args.label,
          ...record,
          refetchLimitHits: session.limitHits - seenLimitHits,
          misses: session.misses - seenMisses,
        };
        seenLimitHits = session.limitHits;
        seenMisses = session.misses;
        appendFileSync(args.out, `${JSON.stringify(row)}\n`);
        console.error(
          `${args.label} ${record.pair} ${record.slot} x${record.ratio} ` +
            `${record.metrics?.totalMs ?? '-'}ms${record.error === null ? '' : ` error=${record.error}`}`,
        );
      },
      shouldStop: () => false,
      pause:
        args.mode === 'record'
          ? async () => {
              await session.settle();
              saveStore(args.store, store);
              await new Promise((resolve) => setTimeout(resolve, recordPauseMs));
            }
          : undefined,
    },
  );

  await session.settle();
  if (args.mode === 'record' || session.misses > 0) saveStore(args.store, store);
  console.error(`misses ${session.misses}`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (new Date(2026, 0, 1).getTimezoneOffset() !== -540) {
    console.error('TZ=Asia/Tokyo で実行してください');
    return 2;
  }
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(argv);
  } catch (error) {
    console.error(String(error));
    console.error(replayUsage);
    return 2;
  }
  return runReplay(args);
}
