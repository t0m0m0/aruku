import { isRecord } from '@aruku/engine/json';
import { GeoPoint } from '@aruku/engine/models/geo-point';
import { TimeoutException } from '@aruku/engine/services/http-client';

import { requireUsableBase } from '../http/base-url';
import type { AbortableHttpClient } from '../http/http';
import type { PlacePrediction } from './place-prediction';

export class PlacesException extends Error {
  constructor(readonly status: string) {
    super(`PlacesException(${status})`);
    this.name = 'PlacesException';
  }
}

export interface PlacesService {
  autocomplete(
    query: string,
    bias?: GeoPoint | null,
    signal?: AbortSignal,
  ): Promise<PlacePrediction[]>;

  fetchLatLng(placeId: string): Promise<GeoPoint | null>;

  close(): void;
}

export interface GooglePlacesServiceOptions {
  readonly client: AbortableHttpClient;
  readonly proxyBaseUrl: string;
}

export class GooglePlacesService implements PlacesService {
  constructor(options: GooglePlacesServiceOptions) {
    requireUsableBase(options.proxyBaseUrl, 'VITE_PROXY_BASE_URL', 'GooglePlacesService');
    this.client = options.client;
    this.proxyBaseUrl = options.proxyBaseUrl.replace(/\/+$/, '');
  }

  private readonly client: AbortableHttpClient;
  private readonly proxyBaseUrl: string;

  async autocomplete(
    query: string,
    bias: GeoPoint | null = null,
    signal?: AbortSignal,
  ): Promise<PlacePrediction[]> {
    const url = this.endpoint({
      action: 'autocomplete',
      input: query,
      language: 'ja',
      components: 'country:jp',
      ...(bias !== null ? { lat: `${bias.lat}`, lon: `${bias.lng}` } : {}),
    });

    const body = await this.getJson(url, signal);
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

  private async getJson(url: URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let response;
    try {
      response = await this.client.get(url, signal === undefined ? {} : { signal });
    } catch (error) {
      if (error instanceof TimeoutException) {
        throw new PlacesException('TIMEOUT');
      }
      throw error;
    }
    if (response.statusCode !== 200) {
      throw new PlacesException(`HTTP ${response.statusCode}`);
    }
    const text = new TextDecoder().decode(response.bodyBytes);
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : {};
  }
}

function toPrediction(raw: unknown): PlacePrediction {
  const map = isRecord(raw) ? raw : {};
  const description = typeof map['description'] === 'string' ? map['description'] : '';

  const terms = map['terms'];
  const firstTerm: unknown = Array.isArray(terms) ? terms[0] : undefined;
  const termValue = isRecord(firstTerm) ? firstTerm['value'] : undefined;
  const name = typeof termValue === 'string' ? termValue : description;

  const distance = map['distance_meters'];

  return {
    placeId: typeof map['place_id'] === 'string' ? map['place_id'] : '',
    name,
    address: addressFrom(description),
    distanceMeters: typeof distance === 'number' ? Math.trunc(distance) : null,
  };
}

function addressFrom(description: string): string {
  const comma = description.indexOf(',');
  return comma >= 0 ? description.slice(comma + 1).trimStart() : description;
}

function readLocation(result: unknown): { lat: number; lng: number } | null {
  if (!isRecord(result)) return null;
  const geometry = result['geometry'];
  if (!isRecord(geometry)) return null;
  const location = geometry['location'];
  if (!isRecord(location)) return null;
  const { lat, lng } = location;
  return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
}
