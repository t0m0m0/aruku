import type { GeoPoint } from '../models/geo-point';
import type { RoutePlan } from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { seconds, type Duration } from '../time';
import { CancellationToken } from './cancellation';

export const RoutePhase = {
  routing: 'routing',
  walkability: 'walkability',
  building: 'building',
} as const;
export type RoutePhase = (typeof RoutePhase)[keyof typeof RoutePhase];

export interface PlanArgs {
  destination: string | null;
  destinationLatLng: GeoPoint | null;
  departure: TimeValue;
  arrival: TimeValue;
  origin?: GeoPoint | null;
  originName?: string | null;
  onProgress?: (phase: RoutePhase) => void;
}

export interface RouteService {
  plan(
    args: PlanArgs & {
      cancellation?: CancellationToken | null;
    },
  ): Promise<RoutePlan>;
}

export interface SearchEngine {
  plan(args: PlanArgs): Promise<RoutePlan>;

  close(): void;
}

export type SearchEngineFactory = (cancellation: CancellationToken) => SearchEngine;

export class RouteException extends Error {
  constructor(readonly status: string) {
    super(`RouteException(${status})`);
    this.name = 'RouteException';
  }
}

export class SearchScopedRouteService implements RouteService {
  constructor(private readonly buildEngine: SearchEngineFactory) {}

  async plan(args: PlanArgs & { cancellation?: CancellationToken | null }): Promise<RoutePlan> {
    const token = args.cancellation ?? new CancellationToken();
    const engine = this.buildEngine(token);

    let closed = false;
    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      engine.close();
    };

    token.onCancel(closeOnce);
    try {
      const result = await engine.plan(args);
      token.throwIfCanceled();
      return result;
    } catch (error) {
      token.throwIfCanceled();
      throw error;
    } finally {
      closeOnce();
    }
  }
}

export const transitRequestTimeout: Duration = seconds(35);

export const proxyRequestTimeout: Duration = seconds(15);

export const searchDeadlineBudget: Duration = seconds(120);
