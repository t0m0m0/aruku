import { dartDouble } from '../dart-number';
import { isRecord, type JsonMap } from '../json';
import type { GeoPoint } from '../models/geo-point';
import { SearchCanceledException, type CancellationToken } from './cancellation';
import { TimeoutException, type HttpClient, type HttpResponse } from './http-client';
import { RouteException } from './route-service';
import { SearchDeadline } from './search-deadline';
import { durationZero, type Duration } from '../time';

const avoidModesTrainOnly = ['bus', 'ferry', 'air'];

const avoidModesAllowBus = ['ferry', 'air'];

const numItineraries = 5;

const guidancePurposes = ['initial', 'arrival', 'boarding', 'names', 'boardSearch', 'bus'] as const;

type GuidancePurpose = (typeof guidancePurposes)[number];

type GuidanceCallsByPurpose = Readonly<Record<GuidancePurpose, number>>;

export interface TransitApiClientInit {
  transitClient?: HttpClient;
  proxyClient?: HttpClient;

  transitBaseUrl?: string;
  proxyBaseUrl?: string;

  cancellation?: CancellationToken | null;

  deadline?: SearchDeadline;

  recordForReplay?: boolean;
}

export class TransitApiClient {
  constructor(init: TransitApiClientInit = {}) {
    this.transit = init.transitClient ?? null;
    this.proxy = init.proxyClient ?? null;
    this.transitBase = stripTrailingSlashes(init.transitBaseUrl ?? '');
    this.proxyBase = stripTrailingSlashes(init.proxyBaseUrl ?? '');
    this.cancellation = init.cancellation ?? null;
    this.deadline = init.deadline ?? SearchDeadline.none();
    this.recorded = init.recordForReplay === true ? new Map() : null;
  }

  private readonly recorded: Map<string, Promise<HttpResponse>> | null;
  private replaying = false;

  startReplay(): void {
    this.replaying = true;
  }

  private readonly transit: HttpClient | null;
  private readonly proxy: HttpClient | null;
  private readonly transitBase: string;
  private readonly proxyBase: string;
  readonly cancellation: CancellationToken | null;
  readonly deadline: SearchDeadline;

  private guidanceCallCount = 0;
  private walkCallCount = 0;
  private matrixCallCount = 0;
  private matrixElementCount = 0;
  private exactCallCount = 0;

  private guidanceDupCallCount = 0;
  private readonly guidanceKeys = new Set<string>();

  private readonly guidanceResponses = new Map<string, Promise<HttpResponse>>();
  private guidanceCacheHitCount = 0;
  private readonly guidanceCallCountByPurpose: Record<GuidancePurpose, number> = {
    initial: 0,
    arrival: 0,
    boarding: 0,
    names: 0,
    boardSearch: 0,
    bus: 0,
  };

  get guidanceCallsByPurpose(): GuidanceCallsByPurpose {
    return { ...this.guidanceCallCountByPurpose };
  }

  get guidanceCalls(): number {
    return this.guidanceCallCount;
  }

  get guidanceDupCalls(): number {
    return this.guidanceDupCallCount;
  }

  get guidanceCacheHits(): number {
    return this.guidanceCacheHitCount;
  }

  get walkCalls(): number {
    return this.walkCallCount;
  }

  get matrixCalls(): number {
    return this.matrixCallCount;
  }

  get matrixElements(): number {
    return this.matrixElementCount;
  }

  get exactCalls(): number {
    return this.exactCallCount;
  }

  get transitBaseUrl(): string {
    return this.transitBase;
  }

  get hasTransitApi(): boolean {
    return this.transitBase.length > 0;
  }

  async fetchGuidanceAt(
    start: GeoPoint,
    goal: GeoPoint,
    at: Date,
    options: { allowBus?: boolean; purpose: Exclude<GuidancePurpose, 'arrival'> },
  ): Promise<JsonMap> {
    return this.fetchGuidance(start, goal, {
      date: formatDate(at),
      time: formatTime(at),
      type: 'departure',
      allowBus: options.allowBus ?? false,
      purpose: options.purpose,
    });
  }

  async fetchGuidanceArrivalAt(
    start: GeoPoint,
    goal: GeoPoint,
    departureAt: Date,
    budgetMin: number,
    options: { allowBus?: boolean } = {},
  ): Promise<JsonMap> {
    return this.fetchGuidance(start, goal, {
      date: formatDate(departureAt),
      time: formatServiceTime(departureAt, budgetMin),
      type: 'arrival',
      allowBus: options.allowBus ?? false,
      purpose: 'arrival',
    });
  }

  private async fetchGuidance(
    start: GeoPoint,
    goal: GeoPoint,
    anchor: {
      date: string;
      time: string;
      type: string;
      allowBus: boolean;
      purpose: GuidancePurpose;
    },
  ): Promise<JsonMap> {
    const uri = buildUri(this.transitBase, '/api/v1/guidance/plan', {
      from: `geo:${dartDouble(start.lat)},${dartDouble(start.lng)}`,
      to: `geo:${dartDouble(goal.lat)},${dartDouble(goal.lng)}`,
      date: anchor.date,
      time: anchor.time,
      type: anchor.type,
      numItineraries: `${numItineraries}`,
      avoidModes: (anchor.allowBus ? avoidModesAllowBus : avoidModesTrainOnly).join(','),
    });
    const key = uri.href;
    let response = this.guidanceResponses.get(key);
    if (response === undefined) {
      response = this.getOrTimeout(this.transit, uri, {
        onIssued: () => {
          this.guidanceCallCount++;
          this.guidanceCallCountByPurpose[anchor.purpose]++;
          if (this.guidanceKeys.has(key)) this.guidanceDupCallCount++;
          this.guidanceKeys.add(key);
        },
      }).then((res) => {
        if (res.statusCode !== 200) {
          throw new RouteException(`HTTP ${res.statusCode}`);
        }
        decodeJsonMap(res);
        return res;
      });
      this.guidanceResponses.set(key, response);
      response.catch(() => this.guidanceResponses.delete(key));
    } else {
      this.cancellation?.throwIfCanceled();
      this.guidanceCacheHitCount++;
    }
    return decodeJsonMap(await response);
  }

  async fetchWalkMatrix(origins: GeoPoint[], dests: GeoPoint[]): Promise<unknown[] | null> {
    try {
      return await this.fetchProxyArray(
        'googleWalkMatrixProxy',
        { origins: joinPoints(origins), destinations: joinPoints(dests) },
        () => {
          this.matrixCallCount++;
          this.matrixElementCount += origins.length * dests.length;
        },
      );
    } catch (error) {
      if (error instanceof RouteException) return null;
      throw error;
    }
  }

  fetchWalkRoute(origin: GeoPoint, dest: GeoPoint): Promise<JsonMap> {
    return this.fetchProxy(
      'googleWalkProxy',
      {
        start: `${dartDouble(origin.lat)},${dartDouble(origin.lng)}`,
        goal: `${dartDouble(dest.lat)},${dartDouble(dest.lng)}`,
      },
      () => this.walkCallCount++,
    );
  }

  fetchExactWalkMax(
    origin: GeoPoint,
    goal: GeoPoint,
    departureAt: Date,
    budgetMin: number,
    { transfers = false }: { transfers?: boolean } = {},
  ): Promise<JsonMap> {
    return this.fetchProxy(
      'exactWalkMax',
      {
        origin: `${dartDouble(origin.lat)},${dartDouble(origin.lng)}`,
        goal: `${dartDouble(goal.lat)},${dartDouble(goal.lng)}`,
        departAt: formatJstInstant(departureAt),
        budgetMin: `${budgetMin}`,
        ...(transfers ? { transfers: '1' } : {}),
      },
      () => this.exactCallCount++,
    );
  }

  private async fetchProxy(
    path: string,
    params: Record<string, string>,
    onIssued: () => void,
  ): Promise<JsonMap> {
    const res = await this.getOrTimeout(this.proxy, buildUri(this.proxyBase, `/${path}`, params), {
      deadlineApplies: false,
      onIssued,
    });
    if (res.statusCode !== 200) {
      throw new RouteException(`HTTP ${res.statusCode}`);
    }
    return decodeJsonMap(res);
  }

  private async fetchProxyArray(
    path: string,
    params: Record<string, string>,
    onIssued: () => void,
  ): Promise<unknown[]> {
    const res = await this.getOrTimeout(this.proxy, buildUri(this.proxyBase, `/${path}`, params), {
      deadlineApplies: false,
      onIssued,
    });
    if (res.statusCode !== 200) {
      throw new RouteException(`HTTP ${res.statusCode}`);
    }
    const decoded = decodeJson(res);
    if (!isArray(decoded)) {
      throw new RouteException('MATRIX_NOT_ARRAY');
    }
    return decoded;
  }

  private getOrTimeout(
    client: HttpClient | null,
    uri: URL,
    options: { deadlineApplies?: boolean; onIssued?: () => void },
  ): Promise<HttpResponse> {
    const recorded = this.recorded;
    if (recorded === null) return this.issue(client, uri, options);
    const key = uri.href;
    const replayed = this.replaying ? recorded.get(key) : undefined;
    if (replayed !== undefined) {
      this.cancellation?.throwIfCanceled();
      return replayed;
    }
    const outcome = this.issue(client, uri, options);
    outcome.then(
      () => recorded.set(key, outcome),
      (error: unknown) => {
        if (!(error instanceof SearchCanceledException)) recorded.set(key, outcome);
      },
    );
    return outcome;
  }

  private async issue(
    client: HttpClient | null,
    uri: URL,
    options: { deadlineApplies?: boolean; onIssued?: () => void },
  ): Promise<HttpResponse> {
    this.cancellation?.throwIfCanceled();
    const remaining = (options.deadlineApplies ?? true) ? this.deadline.remaining : null;
    if (remaining === durationZero) throw new RouteException('TIMEOUT');
    if (client === null) {
      throw new Error('TransitApiClient: no HTTP client was injected');
    }
    try {
      options.onIssued?.();
      const request = client.get(uri);
      return await (remaining === null ? request : withDeadline(request, remaining));
    } catch (error) {
      if (error instanceof TimeoutException) {
        throw new RouteException('TIMEOUT');
      }
      this.cancellation?.throwIfCanceled();
      throw error;
    }
  }

  close(): void {
    this.transit?.close();
    this.proxy?.close();
  }
}

function withDeadline<T>(promise: Promise<T>, limit: Duration): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutException(`deadline exceeded after ${limit}ms`)),
      limit,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function joinPoints(ps: GeoPoint[]): string {
  return ps.map((p) => `${dartDouble(p.lat)},${dartDouble(p.lng)}`).join(';');
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildUri(base: string, path: string, params: Record<string, string>): URL {
  const uri = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    uri.searchParams.set(key, value);
  }
  return uri;
}

function decodeJson(res: HttpResponse): unknown {
  return JSON.parse(new TextDecoder().decode(res.bodyBytes));
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function decodeJsonMap(res: HttpResponse): JsonMap {
  const decoded = decodeJson(res);
  if (!isRecord(decoded)) throw new TypeError('expected a JSON object');
  return decoded;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatDate(dt: Date): string {
  return `${pad(dt.getFullYear(), 4)}${pad(dt.getMonth() + 1, 2)}${pad(dt.getDate(), 2)}`;
}

function formatTime(dt: Date): string {
  return `${pad(dt.getHours(), 2)}:${pad(dt.getMinutes(), 2)}`;
}

function formatJstInstant(at: Date): string {
  return (
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1, 2)}-${pad(at.getDate(), 2)}` +
    `T${pad(at.getHours(), 2)}:${pad(at.getMinutes(), 2)}:${pad(at.getSeconds(), 2)}+09:00`
  );
}

function formatServiceTime(departureAt: Date, budgetMin: number): string {
  const total = departureAt.getHours() * 60 + departureAt.getMinutes() + budgetMin;
  return `${pad(Math.trunc(total / 60), 2)}:${pad(total % 60, 2)}`;
}
