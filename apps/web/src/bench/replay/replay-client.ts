import { GeoPoint } from '@aruku/engine/models/geo-point';
import {
  ClientException,
  TimeoutException,
  type HttpClient,
  type HttpResponse,
} from '@aruku/engine/services/http-client';

import { syntheticWalkResponse } from './synthetic-walk';

export interface ReplayEntry {
  readonly status: number;
  readonly body: string;
  readonly ms: number;
}

export type ReplayStoreData = Partial<Record<string, ReplayEntry>>;

export const timedOutStatus = 599;

export interface ReplaySessionInit {
  readonly mode: 'record' | 'replay';
  readonly store: ReplayStoreData;
  readonly fetchLive: (url: URL) => Promise<ReplayEntry>;
  readonly proxyOrigin: string;
  readonly refetchLimitMs?: number | null;
  readonly isInitial?: (url: URL) => boolean;
  readonly onRequest?: (url: URL) => void;
  readonly exactWalkMax?: (url: URL) => Promise<{ status: number; body: string }>;
  readonly exactDelayMs?: number;
  readonly rideDepartures?: (url: URL) => Promise<{ status: number; body: string }>;
  readonly rideDelayMs?: number;
}

export class ReplaySession {
  constructor(private readonly init: ReplaySessionInit) {
    this.store = init.store;
  }

  readonly store: ReplayStoreData;
  misses = 0;
  limitHits = 0;

  private readonly inflight = new Map<string, Promise<ReplayEntry>>();

  client(): HttpClient {
    return new ReplayHttpClient(this);
  }

  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled(this.inflight.values());
    }
  }

  async resolve(url: URL): Promise<{ entry: ReplayEntry; delayMs: number }> {
    if (url.origin === new URL(this.init.proxyOrigin).origin) {
      if (this.init.exactWalkMax !== undefined && url.pathname.endsWith('/exactWalkMax')) {
        const res = await this.init.exactWalkMax(url);
        const delayMs = this.init.exactDelayMs ?? 0;
        const body = Buffer.from(res.body).toString('base64');
        return { entry: { status: res.status, body, ms: delayMs }, delayMs };
      }
      if (this.init.rideDepartures !== undefined && url.pathname.endsWith('/rideDepartures')) {
        const res = await this.init.rideDepartures(url);
        const delayMs = this.init.rideDelayMs ?? 0;
        const body = Buffer.from(res.body).toString('base64');
        return { entry: { status: res.status, body, ms: delayMs }, delayMs };
      }
      const walk = syntheticWalkResponse(url);
      const entry =
        walk === null
          ? { status: 404, body: '', ms: 0 }
          : { status: 200, body: Buffer.from(walk.body).toString('base64'), ms: walk.delayMs };
      return { entry, delayMs: entry.ms };
    }
    this.init.onRequest?.(url);
    const recorded = this.store[url.href];
    if (this.init.mode === 'replay' && recorded !== undefined) {
      const limit = this.init.refetchLimitMs ?? null;
      if (limit !== null && recorded.ms > limit && this.init.isInitial?.(url) !== true) {
        this.limitHits++;
        return { entry: { status: timedOutStatus, body: '', ms: limit }, delayMs: limit };
      }
      return { entry: recorded, delayMs: recorded.ms };
    }
    if (this.init.mode === 'replay') this.misses++;
    return { entry: await this.fetchOnce(url), delayMs: 0 };
  }

  private fetchOnce(url: URL): Promise<ReplayEntry> {
    const key = url.href;
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = this.init.fetchLive(url).then((entry) => {
        this.store[key] = entry;
        return entry;
      });
      pending.finally(() => this.inflight.delete(key)).catch(() => undefined);
      this.inflight.set(key, pending);
    }
    return pending;
  }
}

class ReplayHttpClient implements HttpClient {
  constructor(private readonly session: ReplaySession) {}

  private closed = false;
  private readonly waiting = new Set<(error: Error) => void>();

  async get(url: URL): Promise<HttpResponse> {
    this.throwIfClosed();
    const { entry, delayMs } = await this.session.resolve(url);
    if (delayMs > 0) await this.wait(delayMs);
    this.throwIfClosed();
    if (entry.status === timedOutStatus)
      throw new TimeoutException(`replayed timeout: ${url.href}`);
    return { statusCode: entry.status, bodyBytes: Buffer.from(entry.body, 'base64') };
  }

  private throwIfClosed(): void {
    if (this.closed) throw new ClientException('closed');
  }

  close(): void {
    this.closed = true;
    for (const abort of this.waiting) abort(new ClientException('closed'));
    this.waiting.clear();
  }

  private wait(ms: number): Promise<void> {
    if (this.closed) return Promise.reject(new ClientException('closed'));
    return new Promise((resolve, reject) => {
      const abort = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        this.waiting.delete(abort);
        resolve();
      }, ms);
      this.waiting.add(abort);
    });
  }
}

export function isInitialQuery(url: URL, origin: GeoPoint, goal: GeoPoint): boolean {
  const from = geoParam(url.searchParams.get('from'));
  const to = geoParam(url.searchParams.get('to'));
  if (from === null || to === null) return false;
  const avoid = (url.searchParams.get('avoidModes') ?? '').split(',');
  return samePoint(from, origin) && samePoint(to, goal) && avoid.includes('bus');
}

function geoParam(value: string | null): GeoPoint | null {
  if (value === null) return null;
  const [lat, lng] = value.replace(/^geo:/, '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? new GeoPoint(lat, lng) : null;
}

const samePoint = (a: GeoPoint, b: GeoPoint): boolean =>
  Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
