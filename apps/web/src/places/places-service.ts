// 移植元: lib/core/services/places_service.dart
//
// Phase 2 はこれをエンジンへ運んでいない。経路エンジンは座標を受け取る側で、
// 地点検索は入力系——`packages/engine` の範囲外だったため（#385）。

import { GeoPoint } from '@aruku/engine/models/geo-point';
import {
  TimeoutException,
  type HttpClient,
} from '@aruku/engine/services/http-client';

import { requireUsableBase } from '../http/base-url';
import type { PlacePrediction } from './place-prediction';

/// 地点検索の失敗。[status] は上流の生ステータス（例: 'REQUEST_DENIED'）で、
/// 文言への変換は画面が持つ（#170）。
export class PlacesException extends Error {
  constructor(readonly status: string) {
    super(`PlacesException(${status})`);
    this.name = 'PlacesException';
  }
}

export interface PlacesService {
  /// 地点検索（typeahead）。[bias] が渡されたときは現在地周辺を優先する位置バイアスを
  /// 掛ける。現在地が分かるときは proxy が origin も渡すため、各候補に現在地からの
  /// 距離（[PlacePrediction.distanceMeters]）が付く（#146）。
  autocomplete(query: string, bias?: GeoPoint | null): Promise<PlacePrediction[]>;

  /// 候補（placeId）から座標を引く。Google autocomplete は座標を返さないため、
  /// 確定時にこの details 呼び出しで補う2段フロー。
  fetchLatLng(placeId: string): Promise<GeoPoint | null>;

  close(): void;
}

export interface GooglePlacesServiceOptions {
  readonly client: HttpClient;
  readonly proxyBaseUrl: string;
}

/// Cloud Functions の placesProxy 経由で Google Places API (New) を叩く。
///
/// API キーはサーバ側に隠蔽し、App Check トークン付きで呼び出す（[client] の合成は
/// `search/places.ts`）。
///
/// 移植元は空の proxyBaseUrl を「候補なし」「座標なし」へ縮退させていたが、それは
/// 運んでいない。設定漏れが「検索しても何も出ない」という**正常な見た目**で出てしまい、
/// 誰も気付けない。`createRouteService` が同じ理由でベース URL を組み立て時に拒んでいる。
export class GooglePlacesService implements PlacesService {
  constructor(options: GooglePlacesServiceOptions) {
    requireUsableBase(
      options.proxyBaseUrl,
      'VITE_PROXY_BASE_URL',
      'GooglePlacesService',
    );
    this.client = options.client;
    // 末尾スラッシュは検査を通る（リライト運用の `https://example.com/api/` がある）ので、
    // 連結前にここで畳む。
    this.proxyBaseUrl = options.proxyBaseUrl.replace(/\/+$/, '');
  }

  private readonly client: HttpClient;
  private readonly proxyBaseUrl: string;

  async autocomplete(
    query: string,
    bias: GeoPoint | null = null,
  ): Promise<PlacePrediction[]> {
    const url = this.endpoint({
      action: 'autocomplete',
      input: query,
      language: 'ja',
      components: 'country:jp',
      // 現在地が分かるときだけ位置バイアスを渡す。proxy 側で locationBias へ。
      ...(bias !== null ? { lat: `${bias.lat}`, lon: `${bias.lng}` } : {}),
    });

    const body = await this.getJson(url);
    const status = body['status'];
    if (status === 'ZERO_RESULTS') return [];
    if (status !== 'OK') throw new PlacesException(String(status));

    const predictions = body['predictions'];
    if (!Array.isArray(predictions)) return [];
    return predictions.map(toPrediction);
  }

  async fetchLatLng(placeId: string): Promise<GeoPoint | null> {
    const url = this.endpoint({ action: 'details', place_id: placeId });

    const body = await this.getJson(url);
    if (body['status'] !== 'OK') return null;

    const location = readLocation(body['result']);
    if (location === null) return null;
    return new GeoPoint(location.lat, location.lng);
  }

  close(): void {
    this.client.close();
  }

  private endpoint(params: Record<string, string>): URL {
    const url = new URL(`${this.proxyBaseUrl}/placesProxy`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  /// 200 を確かめて JSON として読む。autocomplete / details で同じ規則。
  private async getJson(url: URL): Promise<Record<string, unknown>> {
    let response;
    try {
      response = await this.client.get(url);
    } catch (error) {
      // タイムアウトは TimeoutHttpClient が投げる（#156）。他の失敗と同じ語彙へ
      // 寄せて、画面が生ステータスを出す経路に乗せる。
      if (error instanceof TimeoutException) {
        throw new PlacesException('TIMEOUT');
      }
      throw error;
    }
    if (response.statusCode !== 200) {
      throw new PlacesException(`HTTP ${response.statusCode}`);
    }
    // バイト列から明示的に UTF-8 として読む。`Response.text()` を経由しないのは、
    // 層の契約（HttpResponse）が bodyBytes しか持たないため。
    const text = new TextDecoder().decode(response.bodyBytes);
    return JSON.parse(text) as Record<string, unknown>;
  }
}

/// レガシー prediction を [PlacePrediction] へ。proxy が origin を渡したときに付く
/// distance_meters を距離として取り込む（#146 C案）。
function toPrediction(raw: unknown): PlacePrediction {
  const map = (raw ?? {}) as Record<string, unknown>;
  const description = typeof map['description'] === 'string' ? map['description'] : '';

  const terms = map['terms'];
  const firstTerm = Array.isArray(terms) ? terms[0] : undefined;
  const termValue =
    typeof firstTerm === 'object' && firstTerm !== null
      ? (firstTerm as Record<string, unknown>)['value']
      : undefined;
  const name = typeof termValue === 'string' ? termValue : description;

  const distance = map['distance_meters'];

  return {
    placeId: typeof map['place_id'] === 'string' ? map['place_id'] : '',
    name,
    address: addressFrom(description),
    // Dart の `.toInt()` と同じくゼロ方向へ切り捨てる。
    distanceMeters: typeof distance === 'number' ? Math.trunc(distance) : null,
  };
}

/// 先頭の "名称, 住所…" から住所部を取り出す。
///
/// カンマ直後の空白の有無に依存せず、カンマが末尾でも範囲外にならないよう
/// indexOf+1 で切って左空白を落とす（移植元と同じ）。
function addressFrom(description: string): string {
  const comma = description.indexOf(',');
  return comma >= 0 ? description.slice(comma + 1).trimStart() : description;
}

function readLocation(result: unknown): { lat: number; lng: number } | null {
  if (typeof result !== 'object' || result === null) return null;
  const geometry = (result as Record<string, unknown>)['geometry'];
  if (typeof geometry !== 'object' || geometry === null) return null;
  const location = (geometry as Record<string, unknown>)['location'];
  if (typeof location === 'object' && location !== null) {
    const { lat, lng } = location as Record<string, unknown>;
    if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
  }
  return null;
}
