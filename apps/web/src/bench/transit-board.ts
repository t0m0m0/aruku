import { isRecord } from '@aruku/engine/json';
import type { HttpClient, HttpResponse } from '@aruku/engine/services/http-client';

import type { BoardDeparture, BoardStation } from './ab-verify';

const suggestLimit = 30;

const departuresLimit = 20;

const notRedistributed = 'sourceTimetableNotRedistributed';

export function transitBoardApi(
  client: HttpClient,
  baseUrl: string,
): {
  findStations(name: string): Promise<BoardStation[]>;
  fetchDepartures(stationId: string, date: string, time: string): Promise<BoardDeparture[] | null>;
} {
  return {
    async findStations(name) {
      const url = new URL('/api/v1/locations/suggest', baseUrl);
      url.searchParams.set('q', name);
      url.searchParams.set('limit', `${suggestLimit}`);
      const res = await client.get(url);
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      return listIn(decode(res), 'stations').flatMap(toBoardStation);
    },

    async fetchDepartures(stationId, date, time) {
      const url = new URL(`/api/v1/stations/${encodeURIComponent(stationId)}/departures`, baseUrl);
      url.searchParams.set('date', date);
      url.searchParams.set('time', time);
      url.searchParams.set('limit', `${departuresLimit}`);
      const res = await client.get(url);
      if (res.statusCode === 403 && errorCode(res) === notRedistributed) return null;
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      return listIn(decode(res), 'departures').flatMap(toBoardDeparture);
    },
  };
}

function listIn(body: unknown, key: string): unknown[] {
  const list = isRecord(body) ? body[key] : undefined;
  return Array.isArray(list) ? list : [];
}

function toBoardStation(raw: unknown): BoardStation[] {
  if (!isRecord(raw)) return [];
  const { id, feedId, name, lat, lon, kind } = raw;
  return kind !== 'stop' &&
    typeof id === 'string' &&
    typeof feedId === 'string' &&
    typeof name === 'string' &&
    typeof lat === 'number' &&
    typeof lon === 'number'
    ? [{ id, feedId, name, lat, lng: lon }]
    : [];
}

function toBoardDeparture(raw: unknown): BoardDeparture[] {
  if (!isRecord(raw)) return [];
  const { tripId, routeName, headsign, departureSecs } = raw;
  return typeof tripId === 'string' &&
    typeof routeName === 'string' &&
    typeof departureSecs === 'number'
    ? [{ tripId, routeName, headsign: typeof headsign === 'string' ? headsign : '', departureSecs }]
    : [];
}

function decode(res: HttpResponse): unknown {
  return JSON.parse(new TextDecoder().decode(res.bodyBytes));
}

function errorCode(res: HttpResponse): string | null {
  try {
    const body = decode(res);
    const error = isRecord(body) ? body['error'] : undefined;
    const code = isRecord(error) ? error['code'] : undefined;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}
