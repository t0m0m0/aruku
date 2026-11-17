// 再生ハーネス（#504）がエンジンへ注入する HttpClient。
//
// Transit API の応答を URL ごとに録画し、同じ応答を録画した遅延で返す。比べる版の両方へ
// 同じ上流を見せることで、上流のばらつき（中央値 9〜11 秒・裾 30 秒超、
// docs/spec/route-optimization.md §2.2-6）を版の差から消す。

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
  /// 応答本文の base64。
  readonly body: string;
  /// 発行から本文を受け取るまでの実時間。
  readonly ms: number;
}

/// 照会 URL（`href`）→ 録画。
export type ReplayStoreData = Record<string, ReplayEntry>;

/// 上流が返さなかった照会（タイムアウト・通信失敗）の印。HTTP のステータスとは重ならない。
export const timedOutStatus = 599;

export interface ReplaySessionInit {
  /// `record` は録画の有無に関わらず上流へ取りに行き、録画を置き換える。
  readonly mode: 'record' | 'replay';
  readonly store: ReplayStoreData;
  readonly fetchLive: (url: URL) => Promise<ReplayEntry>;
  /// 徒歩プロキシの origin。ここ宛ての照会には合成応答を返す（synthetic-walk.ts）。
  readonly proxyOrigin: string;
  /// 引き直しの1本の上限の模擬（#503）。録画の遅延がこれを超える照会を、この時刻に
  /// タイムアウトさせる。エンジンの `transitRequestTimeout` は通らない——上限を変えた版の
  /// エンジンを作らずに見込みを測るため。
  readonly refetchLimitMs?: number | null;
  /// 上限を掛けない照会（初回の2波）。
  readonly isInitial?: (url: URL) => boolean;
  /// 発行した Transit の照会の通知（呼び出し元の記録など）。
  readonly onRequest?: (url: URL) => void;
  /// 徒歩プロキシの origin 宛ての `exactWalkMax` に答える関数（#513・exact-replay.ts）。
  /// 省略すると、合成できない経路として 404 を返す。
  readonly exactWalkMax?: (url: URL) => Promise<{ status: number; body: string }>;
  /// [exactWalkMax] の応答を返すまでの遅延。
  readonly exactDelayMs?: number;
}

/// 1回の実行で共有する録画と計数。クライアントは検索ごとに作って閉じる（エンジンが検索の
/// 寿命でクライアントを所有するため・#259）。
export class ReplaySession {
  constructor(private readonly init: ReplaySessionInit) {
    this.store = init.store;
  }

  readonly store: ReplayStoreData;
  /// 再生モードで録画に無く、上流へ取りに行った照会の数。0 でない再生は、上流の
  /// ばらつきを含むので版の差として読めない。
  misses = 0;
  /// 引き直しの上限の模擬でタイムアウトさせた照会の数。
  limitHits = 0;

  private readonly inflight = new Map<string, Promise<ReplayEntry>>();

  client(): HttpClient {
    return new ReplayHttpClient(this);
  }

  /// 上流へ取りに行っている照会がすべて録画に入るまで待つ。検索はクライアントを閉じても
  /// 上流の fetch を止めない（猶予切れで捨てた照会など）ので、保存の前に呼ぶ。
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  /// 照会1本の応答と、それを返すまでに待つ時間。
  async resolve(url: URL): Promise<{ entry: ReplayEntry; delayMs: number }> {
    if (url.origin === new URL(this.init.proxyOrigin).origin) {
      if (this.init.exactWalkMax !== undefined && url.pathname.endsWith('/exactWalkMax')) {
        const res = await this.init.exactWalkMax(url);
        const delayMs = this.init.exactDelayMs ?? 0;
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
    // 上流の実時間はもう払ったので、録画の遅延を重ねて待たない。
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
    if (this.closed) throw new ClientException('closed');
    const { entry, delayMs } = await this.session.resolve(url);
    if (delayMs > 0) await this.wait(delayMs);
    if (this.closed) throw new ClientException('closed');
    if (entry.status === timedOutStatus) throw new TimeoutException(`replayed timeout: ${url.href}`);
    return { statusCode: entry.status, bodyBytes: Buffer.from(entry.body, 'base64') };
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

/// 出発地→目的地を電車だけで引く照会（初回の departure 波・arrival 波）か。バスを許す
/// 照会は last-resort の再照会（docs/spec/route-optimization.md §1.1）なので含めない。
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
