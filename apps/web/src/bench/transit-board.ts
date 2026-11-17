// 照合（ab-verify.ts）が使う、Transit API の駅の検索と駅の発車表（#462）。
//
// エンジンの TransitApiClient に足していない。経路検索は発車表を使わず、ベンチの照合だけの
// 往復を検索の往復本数（#309 の計上）や締切と同じクライアントに混ぜないため。

import { isRecord } from '@aruku/engine/json';
import type { HttpClient, HttpResponse } from '@aruku/engine/services/http-client';

import type { BoardDeparture, BoardStation } from './ab-verify';

/// 駅名の候補は事業者・路線ごとに別の駅として返る（新宿だけで十数件）ので、上限まで取る。
const suggestLimit = 30;

/// 乗車駅で同じ分に発つ便と、その前後を拾える本数。発車表はフィードごとなので多くは要らない。
const departuresLimit = 20;

/// ODPT 由来のフィードは、経路探索には使うが駅の発車表としては公開しない（API の再配布条件）。
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
  // 照合するのは時刻表パックの便＝鉄道だけ。駅前のバス停（「三鷹駅」）は同じ駅名に揃い、
  // 発車表を引くだけ往復が増える。
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
