import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import { packObjectPath } from '../../../../../functions/src/timetable-pack/feeds';
import { buildTimetablePack } from '../../../../../functions/src/timetable-pack/pack';
import {
  localExactWalkMax,
  localRideDepartures,
  packDirReader,
} from '../../../src/bench/replay/exact-replay';
import { syntheticWalkSeconds } from '../../../src/bench/replay/synthetic-walk';

const BOARD = { lat: 35.6, lng: 139.7 };
const ALIGHT = { lat: 35.65, lng: 139.7 };
const pack = buildTimetablePack([
  {
    id: 'Test',
    fetchedAt: '2026-11-17T00:00:00.000Z',
    files: {
      'stops.txt': `stop_id,stop_name,stop_lat,stop_lon\nA,乗る駅,${BOARD.lat},${BOARD.lng}\nB,降りる駅,${ALIGHT.lat},${ALIGHT.lng}\n`,
      'routes.txt': 'route_id,route_long_name\nR,テスト線\n',
      'trips.txt': 'route_id,service_id,trip_id\nR,S,T\n',
      'stop_times.txt':
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,10:00:00,10:00:00,A,1\nT,10:10:00,10:10:00,B,2\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nS,20261120,1\n',
    },
  },
]);

const ORIGIN = { lat: 35.598, lng: 139.7 };
const GOAL = { lat: 35.652, lng: 139.7 };
const NOW = new Date('2026-11-20T00:00:00+09:00');

const exactUrl = (params: Record<string, string>): URL => {
  const url = new URL('https://proxy.invalid/exactWalkMax');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
};
const QUERY = {
  origin: `${ORIGIN.lat},${ORIGIN.lng}`,
  goal: `${GOAL.lat},${GOAL.lng}`,
  departAt: '2026-11-20T09:50:00+09:00',
  budgetMin: '60',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exact-replay-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writePack = (group: 'permanent' | 'minitokyo3d'): void => {
  const file = join(dir, packObjectPath(group));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, gzipSync(JSON.stringify(pack)));
};

describe('packDirReader', () => {
  it('pack:local の出力と同じ置き方のパックを読み、無いグループは null を返す', async () => {
    writePack('permanent');
    const read = packDirReader(dir);
    expect((await read(packObjectPath('permanent')))?.byteLength).toBeGreaterThan(0);
    expect(await read(packObjectPath('minitokyo3d'))).toBeNull();
  });
});

describe('localExactWalkMax', () => {
  it('手元のパックで厳密走査を回し、本番の exactWalkMax と同じ形の応答を返す', async () => {
    writePack('permanent');
    const respond = localExactWalkMax({ packDir: dir, now: () => NOW });
    const res = await respond(exactUrl(QUERY));
    expect(res.status).toBe(200);
    const body: unknown = JSON.parse(res.body);
    const aString: unknown = expect.any(String);
    expect(body).toMatchObject({ candidates: [{ route: 'テスト線', boardAt: aString }] });
    expect(body).toHaveProperty('feeds', [{ id: 'Test', fetchedAt: '2026-11-17T00:00:00.000Z' }]);
  });

  it('徒歩は徒歩プロキシと同じ合成の値で測る', async () => {
    writePack('permanent');
    const respond = localExactWalkMax({ packDir: dir, now: () => NOW });
    const body: unknown = JSON.parse((await respond(exactUrl(QUERY))).body);
    expect(body).toHaveProperty(
      ['candidates', 0, 'accessWalk', 'durationSec'],
      syntheticWalkSeconds(
        new GeoPoint(ORIGIN.lat, ORIGIN.lng),
        new GeoPoint(BOARD.lat, BOARD.lng),
      ),
    );
  });

  it('読めるパックが1つも無ければ、本番と同じく 503 を返す', async () => {
    const respond = localExactWalkMax({ packDir: dir, now: () => NOW });
    expect((await respond(exactUrl(QUERY))).status).toBe(503);
  });

  it('読めない照会には、本番と同じく 400 を返す', async () => {
    writePack('permanent');
    const respond = localExactWalkMax({ packDir: dir, now: () => NOW });
    expect((await respond(exactUrl({ ...QUERY, budgetMin: 'x' }))).status).toBe(400);
  });
});

describe('localRideDepartures (#549)', () => {
  const rideUrl = (params: Record<string, string>): URL => {
    const url = new URL('https://proxy.invalid/rideDepartures');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  };
  const RIDE_QUERY = {
    at: '2026-11-20T09:50:00+09:00',
    board: `${BOARD.lat},${BOARD.lng}`,
    alight: `${ALIGHT.lat},${ALIGHT.lng}`,
    boardName: '乗る駅',
    alightName: '降りる駅',
    line: 'テスト線',
  };

  it('手元のパックで発着を引き、本番の rideDepartures と同じ形の応答を返す', async () => {
    writePack('permanent');
    const respond = localRideDepartures({ packDir: dir, now: () => NOW });
    const res = await respond(rideUrl(RIDE_QUERY));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ride: {
        route: 'テスト線',
        from: '乗る駅',
        to: '降りる駅',
        boardAt: '2026-11-20T10:00:00+09:00',
        alightAt: '2026-11-20T10:10:00+09:00',
      },
    });
  });

  it('読めるパックが無ければ 503、読めない照会には 400 を返す', async () => {
    const respond = localRideDepartures({ packDir: dir, now: () => NOW });
    expect((await respond(rideUrl(RIDE_QUERY))).status).toBe(503);
    expect((await respond(rideUrl({ ...RIDE_QUERY, line: '' }))).status).toBe(400);
  });
});
