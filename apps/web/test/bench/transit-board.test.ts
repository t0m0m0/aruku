import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpResponse } from '@aruku/engine/services/http-client';

import { transitBoardApi } from '../../src/bench/transit-board';

function fakeClient(respond: (url: URL) => { status: number; body: unknown }): {
  client: HttpClient;
  urls: URL[];
} {
  const urls: URL[] = [];
  const client: HttpClient = {
    get: async (url: URL): Promise<HttpResponse> => {
      urls.push(url);
      const { status, body } = respond(url);
      return { statusCode: status, bodyBytes: new TextEncoder().encode(JSON.stringify(body)) };
    },
    close: () => {},
  };
  return { client, urls };
}

describe('transitBoardApi: 照合が使う Transit API の駅と発車表', () => {
  it('駅名で駅を引き、座標のある鉄道の駅をフィードつきで返す（同名のバス停は返さない）', async () => {
    const { client, urls } = fakeClient(() => ({
      status: 200,
      body: {
        stations: [
          { id: 'chuo:Mitaka', name: '三鷹', feedId: 'chuo', feedName: '中央線快速', score: 1, weight: 1, lat: 35.69, lon: 139.56 },
          { id: 'bus:1', name: '三鷹', feedId: 'bus', feedName: 'バス', score: 1, weight: 1 },
          { id: 'bus:2', name: '三鷹駅', feedId: 'bus', feedName: 'バス', score: 1, weight: 1, lat: 35.69, lon: 139.56, kind: 'stop' },
        ],
      },
    }));
    const stations = await transitBoardApi(client, 'https://transit.example').findStations('三鷹');
    expect(urls[0].pathname).toEqual('/api/v1/locations/suggest');
    expect(urls[0].searchParams.get('q')).toEqual('三鷹');
    expect(stations).toEqual([{ id: 'chuo:Mitaka', feedId: 'chuo', name: '三鷹', lat: 35.69, lng: 139.56 }]);
  });

  it('発車表を日付・時刻つきで引き、便と発車時刻を返す', async () => {
    const { client, urls } = fakeClient(() => ({
      status: 200,
      body: {
        stationId: 'chuo:Mitaka',
        date: '20261026',
        timezone: 'Asia/Tokyo',
        departures: [
          { routeName: '中央線快速（東京方面）', mode: 'rail', headsign: '中央特快 東京', tripId: 't1', stopId: 's', departureSecs: 44640, headwayBased: false },
          { routeName: '中央線快速（東京方面）', mode: 'rail', tripId: 't2', stopId: 's', departureSecs: 44700, headwayBased: false },
        ],
      },
    }));
    const board = await transitBoardApi(client, 'https://transit.example').fetchDepartures('chuo:Mitaka', '20261026', '12:22');
    expect(urls[0].pathname).toEqual('/api/v1/stations/chuo%3AMitaka/departures');
    expect(urls[0].searchParams.get('date')).toEqual('20261026');
    expect(urls[0].searchParams.get('time')).toEqual('12:22');
    expect(board).toEqual([
      { tripId: 't1', routeName: '中央線快速（東京方面）', headsign: '中央特快 東京', departureSecs: 44640 },
      { tripId: 't2', routeName: '中央線快速（東京方面）', headsign: '', departureSecs: 44700 },
    ]);
  });

  it('発車表を公開しないフィード（ODPT 由来）の駅は null を返す', async () => {
    const { client } = fakeClient(() => ({
      status: 403,
      body: { error: { code: 'sourceTimetableNotRedistributed', message: '…' } },
    }));
    expect(await transitBoardApi(client, 'https://transit.example').fetchDepartures('metro:x', '20261026', '12:00')).toBeNull();
  });

  it('それ以外の失敗は投げる（レート制限を「発車表なし」に紛れさせない）', async () => {
    const { client } = fakeClient(() => ({ status: 403, body: { error: { code: 'forbidden' } } }));
    await expect(
      transitBoardApi(client, 'https://transit.example').fetchDepartures('chuo:Mitaka', '20261026', '12:00'),
    ).rejects.toThrow('HTTP 403');
    const tooMany = fakeClient(() => ({ status: 429, body: {} }));
    await expect(transitBoardApi(tooMany.client, 'https://transit.example').findStations('三鷹')).rejects.toThrow('HTTP 429');
  });
});
