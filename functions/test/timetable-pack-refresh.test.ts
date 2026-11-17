import { gunzipSync } from 'node:zlib';

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  MINI_TOKYO_3D,
  ODPT_FEEDS,
  packObjectPath,
  type MiniTokyo3dSource,
  type OdptFeed,
} from '../src/timetable-pack/feeds';
import type { TimetablePack } from '../src/timetable-pack/pack';
import { refreshTimetablePacks, type RefreshDeps } from '../src/timetable-pack/refresh';

const CENTER_KEY = 'center-secret-value';
const CHALLENGE_KEY = 'challenge-secret-value';

const gtfsZip = (stopName: string): Uint8Array =>
  zipSync({
    'stops.txt': strToU8(
      `stop_id,stop_name,stop_lat,stop_lon\nA,${stopName},35.0,139.7\nB,${stopName}2,35.01,139.7\n`,
    ),
    'routes.txt': strToU8('route_id,route_long_name\nR,線\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id\nR,S,T\n'),
    'stop_times.txt': strToU8(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,10:00:00,10:00:00,A,1\nT,10:05:00,10:05:00,B,2\n',
    ),
    'calendar_dates.txt': strToU8('service_id,date,exception_type\nS,20261023,1\n'),
  });

const FEEDS: OdptFeed[] = [
  {
    id: 'JR',
    url: 'https://challenge.example/JR.zip',
    key: 'ODPT_CHALLENGE_KEY',
    group: 'challenge',
  },
  {
    id: 'Keio',
    url: 'https://challenge.example/Keio.zip',
    key: 'ODPT_CHALLENGE_KEY',
    group: 'challenge',
  },
  {
    id: 'Metro',
    url: 'https://center.example/Metro.zip',
    key: 'ODPT_CENTER_KEY',
    group: 'permanent',
  },
  { id: 'Toei', url: 'https://public.example/Toei.zip', key: null, group: 'permanent' },
];

interface Harness {
  deps: RefreshDeps;
  requested: string[];
  uploads: Map<string, Uint8Array>;
  logs: Record<string, unknown>[];
}

const harness = (
  respond: (url: string) => Response | Promise<Response> = (url) =>
    new Response(gtfsZip(new URL(url).pathname.slice(1, -4))),
  keys: RefreshDeps['keys'] = { ODPT_CENTER_KEY: CENTER_KEY, ODPT_CHALLENGE_KEY: CHALLENGE_KEY },
): Harness => {
  const requested: string[] = [];
  const uploads = new Map<string, Uint8Array>();
  const logs: Record<string, unknown>[] = [];
  return {
    requested,
    uploads,
    logs,
    deps: {
      fetch: async (input) => {
        const url = input;
        requested.push(url);
        return respond(url);
      },
      keys,
      now: () => new Date('2026-10-23T19:00:00.000Z'),
      upload: async (path, bytes) => {
        uploads.set(path, bytes);
      },
      log: (event) => logs.push(event),
    },
  };
};

const unpack = (bytes: Uint8Array): TimetablePack => JSON.parse(gunzipSync(bytes).toString());

const refreshOdpt = (deps: RefreshDeps, feeds: readonly OdptFeed[]) =>
  refreshTimetablePacks(deps, feeds, null);

describe('refreshTimetablePacks', () => {
  it('ライセンスのグループごとに1つのパックを作り、別々のオブジェクトに置く', async () => {
    const h = harness();
    await refreshOdpt(h.deps, FEEDS);
    expect([...h.uploads.keys()].sort()).toEqual([
      packObjectPath('challenge'),
      packObjectPath('permanent'),
    ]);
    expect(unpack(h.uploads.get(packObjectPath('challenge'))!).feeds.map((f) => f.id)).toEqual([
      'JR',
      'Keio',
    ]);
    expect(unpack(h.uploads.get(packObjectPath('permanent'))!).feeds.map((f) => f.id)).toEqual([
      'Metro',
      'Toei',
    ]);
  });

  it('チャレンジ限定と恒久のパスが、取得元で分かれている（期限後に消す範囲）', () => {
    expect(packObjectPath('challenge')).not.toBe(packObjectPath('permanent'));
    expect(packObjectPath('challenge').startsWith('challenge/')).toBe(true);
  });

  it('フィードごとに、そのフィードのキーを acl:consumerKey で付け、キー不要のフィードには付けない', async () => {
    const h = harness();
    await refreshOdpt(h.deps, FEEDS);
    expect(h.requested.sort()).toEqual([
      `https://center.example/Metro.zip?acl:consumerKey=${CENTER_KEY}`,
      `https://challenge.example/JR.zip?acl:consumerKey=${CHALLENGE_KEY}`,
      `https://challenge.example/Keio.zip?acl:consumerKey=${CHALLENGE_KEY}`,
      'https://public.example/Toei.zip',
    ]);
  });

  it('クエリつきの URL には、キーを & でつないで足す', async () => {
    const h = harness((url) => new Response(gtfsZip(new URL(url).pathname.slice(1, -4))));
    await refreshOdpt(h.deps, [
      {
        id: 'Dated',
        url: 'https://center.example/Dated.zip?date=current',
        key: 'ODPT_CENTER_KEY',
        group: 'permanent',
      },
    ]);
    expect(h.requested).toEqual([
      `https://center.example/Dated.zip?date=current&acl:consumerKey=${CENTER_KEY}`,
    ]);
  });

  it('フィードの路線名の写像をパックに効かせる', async () => {
    const h = harness();
    await refreshOdpt(h.deps, [
      {
        id: 'Toei',
        url: 'https://public.example/Toei.zip',
        key: null,
        group: 'permanent',
        routeName: () => '写した名前',
      },
    ]);
    expect(unpack(h.uploads.get(packObjectPath('permanent'))!).trips[0].route).toBe('写した名前');
  });

  it('取得日時をフィードごとにパックへ残す', async () => {
    const h = harness();
    await refreshOdpt(h.deps, FEEDS);
    const pack = unpack(h.uploads.get(packObjectPath('permanent'))!);
    expect(pack.feeds[0].fetchedAt).toBe('2026-10-23T19:00:00.000Z');
  });

  it('グループの中で1つでも取得に失敗したら、そのグループは上書きしない（前回のパックを残す）', async () => {
    const h = harness((url) =>
      url.includes('Keio')
        ? new Response('Forbidden', { status: 403 })
        : new Response(gtfsZip('X')),
    );
    const results = await refreshOdpt(h.deps, FEEDS);
    expect([...h.uploads.keys()]).toEqual([packObjectPath('permanent')]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: 'challenge', status: 'skipped', failedFeeds: ['Keio'] }),
        expect.objectContaining({ group: 'permanent', status: 'uploaded' }),
      ]),
    );
  });

  it('zip でない応答（エラーページなど）も取得の失敗として扱う', async () => {
    const h = harness((url) =>
      url.includes('Metro') ? new Response('<html>maintenance</html>') : new Response(gtfsZip('X')),
    );
    const results = await refreshOdpt(h.deps, FEEDS);
    expect(h.uploads.has(packObjectPath('permanent'))).toBe(false);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: 'permanent', status: 'skipped', failedFeeds: ['Metro'] }),
      ]),
    );
  });

  it('便が1本も取れないフィード（中身が見出しだけなど）も失敗として扱い、グループを上書きしない', async () => {
    const empty = zipSync({
      'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n'),
      'routes.txt': strToU8('route_id\n'),
      'trips.txt': strToU8('route_id,service_id,trip_id\n'),
      'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'),
      'calendar_dates.txt': strToU8('service_id,date,exception_type\n'),
    });
    const h = harness((url) =>
      url.includes('Toei') ? new Response(empty) : new Response(gtfsZip('X')),
    );
    const results = await refreshOdpt(h.deps, FEEDS);
    expect(h.uploads.has(packObjectPath('permanent'))).toBe(false);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: 'permanent', status: 'skipped', failedFeeds: ['Toei'] }),
      ]),
    );
  });

  it('キーが無いフィードは取りに行かずに失敗にする', async () => {
    const h = harness(undefined, { ODPT_CENTER_KEY: CENTER_KEY });
    const results = await refreshOdpt(h.deps, FEEDS);
    expect(h.requested.some((u) => u.includes('challenge.example'))).toBe(false);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: 'challenge',
          status: 'skipped',
          failedFeeds: ['JR', 'Keio'],
        }),
      ]),
    );
  });

  it('失敗してもログ・結果にキーの値も URL も出さない', async () => {
    const h = harness((url) => {
      if (url.includes('JR')) throw new TypeError(`fetch failed: ${url}`);
      return new Response(`denied ${url}`, { status: 401 });
    });
    const results = await refreshOdpt(h.deps, FEEDS);
    const written = JSON.stringify({ results, logs: h.logs });
    expect(written).not.toContain(CENTER_KEY);
    expect(written).not.toContain(CHALLENGE_KEY);
    expect(written).not.toContain('example');
    expect(h.logs.length).toBeGreaterThan(0);
  });

  it('失敗したフィードの HTTP ステータスをログに残す', async () => {
    const h = harness((url) =>
      url.includes('Keio') ? new Response('', { status: 503 }) : new Response(gtfsZip('X')),
    );
    await refreshOdpt(h.deps, FEEDS);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: 'timetable_feed_fetch', feed: 'Keio', httpStatus: 503 }),
    );
  });
});

describe('ODPT_FEEDS', () => {
  it('10フィードを、#456 の表（と #476 の横浜市営地下鉄）どおりのキーとグループに割り当てる', () => {
    expect(ODPT_FEEDS.map(({ id, key, group }) => `${id}:${key}:${group}`)).toEqual([
      'JR-East:ODPT_CHALLENGE_KEY:challenge',
      'Keio:ODPT_CHALLENGE_KEY:challenge',
      'Tobu:ODPT_CHALLENGE_KEY:challenge',
      'Sotetsu:ODPT_CHALLENGE_KEY:challenge',
      'TokyoMetro:ODPT_CENTER_KEY:permanent',
      'MIR:ODPT_CENTER_KEY:permanent',
      'TWR:ODPT_CENTER_KEY:permanent',
      'TamaMonorail:ODPT_CENTER_KEY:permanent',
      'YokohamaMunicipal:ODPT_CENTER_KEY:permanent',
      'Toei:null:permanent',
    ]);
  });

  // 版ごとのファイルへ飛ばす入口。date を外すと 404 になる（2026-10-26 実測）。
  it('横浜市営地下鉄は、その日に有効な版を date=current で取る', () => {
    const yokohama = ODPT_FEEDS.find((f) => f.id === 'YokohamaMunicipal')!;
    const url = new URL(yokohama.url);
    expect(url.host).toBe('api.odpt.org');
    expect(url.searchParams.get('date')).toBe('current');
  });

  // GTFS の route_long_name は「【BL】【快速】あざみ野　→　湘南台」のような向き・種別つきの系統名。
  it('横浜市営地下鉄の系統名を、ブルーライン・グリーンラインへ寄せる', () => {
    const routeName = ODPT_FEEDS.find((f) => f.id === 'YokohamaMunicipal')!.routeName!;
    expect(routeName('【BL】上永谷　→　湘南台')).toBe('ブルーライン');
    expect(routeName('【BL】【快速】あざみ野　→　湘南台')).toBe('ブルーライン');
    expect(routeName('【GL】中山　→　日吉')).toBe('グリーンライン');
  });

  it('横浜市営地下鉄の知らない系統名は、そのまま残す', () => {
    const routeName = ODPT_FEEDS.find((f) => f.id === 'YokohamaMunicipal')!.routeName!;
    expect(routeName('【XX】どこか　→　どこか')).toBe('【XX】どこか　→　どこか');
  });

  it('チャレンジのキーは api-challenge にだけ送る', () => {
    for (const f of ODPT_FEEDS) {
      expect(f.key === 'ODPT_CHALLENGE_KEY').toBe(new URL(f.url).host === 'api-challenge.odpt.org');
    }
  });
});

describe('refreshTimetablePacks（mini-tokyo-3d）', () => {
  const SOURCE: MiniTokyo3dSource = { commit: 'abc123', operators: ['Tokyu', 'Keisei'] };
  const RAW = 'https://raw.githubusercontent.com/nagix/mini-tokyo-3d/abc123/data/';

  const station = (id: string, lat: number) => ({ id, coord: [139.7, lat], title: { ja: id } });
  const DATA: Record<string, unknown> = {
    'stations.json': [
      station('Tokyu.Toyoko.A', 35.0),
      station('Tokyu.Toyoko.B', 35.01),
      station('Keisei.Main.C', 35.7),
      station('Keisei.Main.D', 35.71),
    ],
    'railways.json': [
      { id: 'Tokyu.Toyoko', title: { ja: '東横線' }, stations: [] },
      { id: 'Keisei.Main', title: { ja: '京成本線' }, stations: [] },
      { id: 'TokyoMetro.Ginza', title: { ja: '銀座線' }, stations: [] },
    ],
    'train-timetables/tokyu-toyoko.json': [
      {
        id: 'Tokyu.Toyoko.1.Weekday',
        t: 'Tokyu.Toyoko.1',
        r: 'Tokyu.Toyoko',
        tt: [
          { s: 'Tokyu.Toyoko.A', d: '10:00' },
          { s: 'Tokyu.Toyoko.B', a: '10:05' },
        ],
      },
    ],
    'train-timetables/keisei-main.json': [
      {
        id: 'Keisei.Main.1.SaturdayHoliday',
        t: 'Keisei.Main.1',
        r: 'Keisei.Main',
        tt: [
          { s: 'Keisei.Main.C', d: '10:00' },
          { s: 'Keisei.Main.D', a: '10:05' },
        ],
      },
    ],
  };

  const respondWith =
    (data: Record<string, unknown>, override: (path: string) => Response | null = () => null) =>
    (url: string) => {
      const path = url.slice(RAW.length);
      return (
        override(path) ??
        (path in data
          ? new Response(JSON.stringify(data[path]))
          : new Response('', { status: 404 }))
      );
    };

  it('固定したコミットの駅・路線と、対象の事業者の路線の時刻表だけを取る', async () => {
    const h = harness(respondWith(DATA));
    await refreshTimetablePacks(h.deps, [], SOURCE);
    expect(h.requested.map((u) => u.slice(RAW.length)).sort()).toEqual([
      'railways.json',
      'stations.json',
      'train-timetables/keisei-main.json',
      'train-timetables/tokyu-toyoko.json',
    ]);
    expect(h.requested.every((u) => u.startsWith(RAW))).toBe(true);
  });

  it('事業者ごとのフィードで1つのパックを作り、ODPT と別のオブジェクトに置く', async () => {
    const h = harness(respondWith(DATA));
    const results = await refreshTimetablePacks(h.deps, [], SOURCE);
    const pack = unpack(h.uploads.get(packObjectPath('minitokyo3d'))!);
    expect(pack.feeds.map((f) => [f.id, f.version])).toEqual([
      ['mini-tokyo-3d/Tokyu', 'abc123'],
      ['mini-tokyo-3d/Keisei', 'abc123'],
    ]);
    expect(results).toEqual([
      expect.objectContaining({ group: 'minitokyo3d', status: 'uploaded', trips: 2 }),
    ]);
  });

  // 取得時刻 2026-10-23T19:00Z は JST で 10/24。exactWalkMax が受ける運行日（前日〜92日先と、
  // 到着指定で押し出される分）を覆う。
  it('運行日は取得した日（JST）の前日から 93 日先までを、ダイヤの種別で振り分けて持つ', async () => {
    const h = harness(respondWith(DATA));
    await refreshTimetablePacks(h.deps, [], SOURCE);
    const pack = unpack(h.uploads.get(packObjectPath('minitokyo3d'))!);
    const all = pack.services.flatMap((s) => s.dates).sort((a, b) => a - b);
    expect(all[0]).toBe(20261023);
    expect(all[all.length - 1]).toBe(20270125);
    const weekday = pack.services[pack.trips[0].service].dates;
    expect(weekday).toContain(20261023);
    expect(weekday).not.toContain(20261024);
  });

  it('どれか1つのファイルが取れなければ、mini-tokyo-3d のパックは上書きしない', async () => {
    const h = harness(
      respondWith(DATA, (path) =>
        path.includes('keisei') ? new Response('', { status: 500 }) : null,
      ),
    );
    const results = await refreshTimetablePacks(h.deps, [], SOURCE);
    expect(h.uploads.has(packObjectPath('minitokyo3d'))).toBe(false);
    expect(results).toEqual([
      { group: 'minitokyo3d', status: 'skipped', failedFeeds: ['mini-tokyo-3d'] },
    ]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: 'timetable_feed_fetch',
        feed: 'mini-tokyo-3d',
        httpStatus: 500,
      }),
    );
  });

  it('JSON として読めない応答も取得の失敗として扱う', async () => {
    const h = harness(
      respondWith(DATA, (path) => (path === 'stations.json' ? new Response('<html>') : null)),
    );
    const results = await refreshTimetablePacks(h.deps, [], SOURCE);
    expect(results).toEqual([
      { group: 'minitokyo3d', status: 'skipped', failedFeeds: ['mini-tokyo-3d'] },
    ]);
  });

  it.each([
    ['駅の一覧が配列でない', { 'stations.json': {} }],
    [
      '駅の座標が数でない',
      { 'stations.json': [{ id: 'Tokyu.Toyoko.A', coord: ['139.7', '35'], title: { ja: 'A' } }] },
    ],
    [
      '路線の駅が配列でない',
      { 'railways.json': [{ id: 'Tokyu.Toyoko', title: { ja: '東横線' } }] },
    ],
    [
      '便の停車が欠けている',
      { 'train-timetables/tokyu-toyoko.json': [{ id: 'x.Weekday', t: 'x', r: 'Tokyu.Toyoko' }] },
    ],
  ])('形の違う JSON（%s）も取得の失敗として扱い、パックは上書きしない', async (_, broken) => {
    const h = harness(respondWith({ ...DATA, ...broken }));
    const results = await refreshTimetablePacks(h.deps, [], SOURCE);
    expect(h.uploads.has(packObjectPath('minitokyo3d'))).toBe(false);
    expect(results).toEqual([
      { group: 'minitokyo3d', status: 'skipped', failedFeeds: ['mini-tokyo-3d'] },
    ]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: 'timetable_feed_fetch',
        feed: 'mini-tokyo-3d',
        reason: 'unexpected_shape',
      }),
    );
  });

  it('便が1本も取れない事業者があれば、そのパックは上書きしない', async () => {
    const h = harness(respondWith({ ...DATA, 'train-timetables/keisei-main.json': [] }));
    const results = await refreshTimetablePacks(h.deps, [], SOURCE);
    expect(h.uploads.has(packObjectPath('minitokyo3d'))).toBe(false);
    expect(results).toEqual([
      { group: 'minitokyo3d', status: 'skipped', failedFeeds: ['mini-tokyo-3d/Keisei'] },
    ]);
  });

  it('mini-tokyo-3d が失敗しても、ODPT のグループは置く', async () => {
    const h = harness((url) =>
      url.startsWith(RAW) ? new Response('', { status: 500 }) : new Response(gtfsZip('X')),
    );
    await refreshTimetablePacks(h.deps, FEEDS, SOURCE);
    expect([...h.uploads.keys()].sort()).toEqual([
      packObjectPath('challenge'),
      packObjectPath('permanent'),
    ]);
  });
});

describe('MINI_TOKYO_3D', () => {
  it('コミットを 40 桁の SHA で固定する（ブランチ名だと知らないうちに中身が変わる）', () => {
    expect(MINI_TOKYO_3D.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // ODPT と同じ事業者を両方から取ると、同じ列車が2本ずつ入る。
  it('ODPT から取っている事業者を含めない', () => {
    const odpt = [
      'JR-East',
      'Keio',
      'Tobu',
      'Sotetsu',
      'TokyoMetro',
      'MIR',
      'TWR',
      'TamaMonorail',
      'YokohamaMunicipal',
      'Toei',
    ];
    expect(MINI_TOKYO_3D.operators.filter((o) => odpt.includes(o))).toEqual([]);
  });
});
