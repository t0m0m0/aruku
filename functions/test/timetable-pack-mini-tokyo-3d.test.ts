import { describe, expect, it } from 'vitest';

import {
  miniTokyo3dFeed,
  parseM3dRailways,
  parseM3dStations,
  parseM3dTrains,
  railwaysOf,
  timetableFileOf,
  type M3dRailway,
  type M3dStation,
  type M3dTrain,
} from '../src/timetable-pack/mini-tokyo-3d';
import { buildTimetablePack, timetableForDate } from '../src/timetable-pack/pack';

const station = (id: string, ja: string, lng: number, lat: number): M3dStation => ({
  id,
  coord: [lng, lat],
  title: { ja },
});

const STATIONS: M3dStation[] = [
  station('Tokyu.Toyoko.Shibuya', '渋谷', 139.7016, 35.658),
  station('Tokyu.Toyoko.NakaMeguro', '中目黒', 139.6988, 35.6441),
  station('Tokyu.Toyoko.Jiyugaoka', '自由が丘', 139.6685, 35.6074),
  station('Minatomirai.Minatomirai.MotomachiChukagai', '元町・中華街', 139.6505, 35.4423),
];

const RAILWAYS: M3dRailway[] = [
  {
    id: 'Tokyu.Toyoko',
    title: { ja: '東横線' },
    stations: ['Tokyu.Toyoko.Shibuya', 'Tokyu.Toyoko.NakaMeguro', 'Tokyu.Toyoko.Jiyugaoka'],
  },
  { id: 'Seibu.S-Fukutoshin', title: { ja: '池袋線' }, stations: [] },
  { id: 'TokyoMetro.Ginza', title: { ja: '銀座線' }, stations: [] },
];

const train = (calendar: string, tt: M3dTrain['tt'], extra: Partial<M3dTrain> = {}): M3dTrain => ({
  id: `Tokyu.Toyoko.001.${calendar}`,
  t: 'Tokyu.Toyoko.001',
  r: 'Tokyu.Toyoko',
  ds: ['Minatomirai.Minatomirai.MotomachiChukagai'],
  tt,
  ...extra,
});

const SIMPLE_CALLS: M3dTrain['tt'] = [
  { s: 'Tokyu.Toyoko.Shibuya', d: '10:00' },
  { s: 'Tokyu.Toyoko.NakaMeguro', a: '10:03', d: '10:04' },
  { s: 'Tokyu.Toyoko.Jiyugaoka', a: '10:10' },
];

// 2026-11-20 は金曜（平日）、11-21 は土曜、11-23 は月曜の祝日。
const DATES = [20261120, 20261121, 20261123];

const build = (trains: M3dTrain[], dates: number[] = DATES) =>
  buildTimetablePack([
    miniTokyo3dFeed({
      operator: 'Tokyu',
      stations: STATIONS,
      railways: RAILWAYS,
      trains,
      dates,
      commit: 'fa7833f',
      fetchedAt: '2026-11-17T00:00:00.000Z',
    }),
  ]);

describe('timetableFileOf', () => {
  it('路線 ID を train-timetables のファイル名へ写す（記号のハイフンは落とす）', () => {
    expect(timetableFileOf('Tokyu.Toyoko')).toBe('tokyu-toyoko.json');
    expect(timetableFileOf('Seibu.S-Fukutoshin')).toBe('seibu-sfukutoshin.json');
    expect(timetableFileOf('OdakyuHakone.HakoneTozan')).toBe('odakyuhakone-hakonetozan.json');
  });
});

describe('railwaysOf', () => {
  it('指定した事業者の路線だけを返す', () => {
    expect(railwaysOf(RAILWAYS, ['Tokyu', 'Seibu']).map((r) => r.id)).toEqual([
      'Tokyu.Toyoko',
      'Seibu.S-Fukutoshin',
    ]);
  });
});

describe('miniTokyo3dFeed', () => {
  it('平日ダイヤの列車は平日だけ、土休日ダイヤの列車は土日祝だけ走る', () => {
    const pack = build([
      train('Weekday', SIMPLE_CALLS),
      train('SaturdayHoliday', SIMPLE_CALLS, {
        id: 'Tokyu.Toyoko.002.SaturdayHoliday',
        t: 'Tokyu.Toyoko.002',
      }),
    ]);
    const datesOf = (trip: number) => pack.services[pack.trips[trip].service].dates;
    expect(datesOf(0)).toEqual([20261120]);
    expect(datesOf(1)).toEqual([20261121, 20261123]);
  });

  it('分割された列車（カレンダーの後ろに番号が付く ID）もカレンダーで振り分ける', () => {
    const pack = build([train('Weekday', SIMPLE_CALLS, { id: 'Tokyu.Toyoko.001.Weekday.2' })]);
    expect(pack.services[pack.trips[0].service].dates).toEqual([20261120]);
  });

  it('知らないカレンダーの列車は取り込まない', () => {
    const pack = build([train('Holiday', SIMPLE_CALLS)]);
    expect(pack.trips).toHaveLength(0);
  });

  it('着だけ・発だけの停車は、もう一方を同じ時刻で埋める', () => {
    const pack = build([train('Weekday', SIMPLE_CALLS)]);
    const [{ calls }] = timetableForDate(pack, '20261120').trips;
    expect(calls.map((c) => [c.arr, c.dep])).toEqual([
      [36000, 36000],
      [36180, 36240],
      [36600, 36600],
    ]);
    expect(calls.every((c) => c.canBoard && c.canAlight)).toBe(true);
  });

  it('0時を過ぎた時刻（00:10 などの表記）は、その運行日の 24 時台として読む', () => {
    const pack = build([
      train('Weekday', [
        { s: 'Tokyu.Toyoko.Shibuya', d: '23:58' },
        { s: 'Tokyu.Toyoko.NakaMeguro', a: '00:01', d: '00:02' },
        { s: 'Tokyu.Toyoko.Jiyugaoka', a: '00:08' },
      ]),
      train(
        'Weekday',
        [
          { s: 'Tokyu.Toyoko.Shibuya', d: '00:20' },
          { s: 'Tokyu.Toyoko.Jiyugaoka', a: '00:30' },
        ],
        { id: 'Tokyu.Toyoko.002.Weekday', t: 'Tokyu.Toyoko.002' },
      ),
    ]);
    expect(pack.trips.map((t) => [t.dep[0], t.arr[t.arr.length - 1]])).toEqual([
      [86280, 86880],
      [87600, 88200],
    ]);
  });

  it('路線名は路線の和名、行先は終着駅の和名、駅は和名と座標を持つ', () => {
    const pack = build([train('Weekday', SIMPLE_CALLS)]);
    expect(pack.trips[0].route).toBe('東横線');
    expect(pack.trips[0].headsign).toBe('元町・中華街');
    expect(pack.stops[pack.trips[0].stops[0]]).toMatchObject({
      name: '渋谷',
      lat: 35.658,
      lng: 139.7016,
    });
  });

  it('駅一覧に無い駅は外し、2駅に満たない列車は取り込まない', () => {
    const pack = build([
      train('Weekday', [
        { s: 'Tokyu.Toyoko.Shibuya', d: '10:00' },
        { s: 'Tokyu.Toyoko.Unknown', a: '10:05' },
      ]),
    ]);
    expect(pack.trips).toHaveLength(0);
  });

  it('座標の無い駅（地図の外の駅）も、駅一覧に無い駅と同じく外す', () => {
    const pack = buildTimetablePack([
      miniTokyo3dFeed({
        operator: 'Tokyu',
        stations: [...STATIONS, { id: 'Tokyu.Toyoko.Far', title: { ja: '遠方' } }],
        railways: RAILWAYS,
        trains: [
          train('Weekday', [
            { s: 'Tokyu.Toyoko.Shibuya', d: '10:00' },
            { s: 'Tokyu.Toyoko.Far', a: '10:05' },
          ]),
        ],
        dates: DATES,
        commit: 'fa7833f',
        fetchedAt: '2026-11-17T00:00:00.000Z',
      }),
    ]);
    expect(pack.trips).toHaveLength(0);
  });

  it('フィードは事業者ごとに分け、版として mini-tokyo-3d のコミットを持つ', () => {
    const pack = build([train('Weekday', SIMPLE_CALLS)]);
    expect(pack.feeds).toEqual([
      { id: 'mini-tokyo-3d/Tokyu', fetchedAt: '2026-11-17T00:00:00.000Z', version: 'fa7833f' },
    ]);
  });

  it('カンマや引用符を含む名前もそのまま残す', () => {
    const stations = STATIONS.map((s) =>
      s.id === 'Minatomirai.Minatomirai.MotomachiChukagai'
        ? { ...s, title: { ja: '元町,"中華街"' } }
        : s,
    );
    const pack = buildTimetablePack([
      miniTokyo3dFeed({
        operator: 'Tokyu',
        stations,
        railways: RAILWAYS,
        trains: [train('Weekday', SIMPLE_CALLS)],
        dates: DATES,
        commit: 'fa7833f',
        fetchedAt: '2026-11-17T00:00:00.000Z',
      }),
    ]);
    expect(pack.trips[0].headsign).toBe('元町,"中華街"');
  });
});

describe('parseM3dStations / parseM3dRailways / parseM3dTrains', () => {
  it('形の合う一覧はそのまま返す（座標の無い駅も含む）', () => {
    const stations = [...STATIONS, { id: 'JR-East.Joban.Otsuko', title: { ja: '大津港' } }];
    expect(parseM3dStations(stations)).toEqual(stations);
    expect(parseM3dRailways(RAILWAYS)).toEqual(RAILWAYS);
    expect(parseM3dTrains([train('Weekday', SIMPLE_CALLS)])).toEqual([
      train('Weekday', SIMPLE_CALLS),
    ]);
  });

  it('配列でないもの、形の違う要素を1つでも含むものは null', () => {
    expect(parseM3dStations({})).toBeNull();
    expect(parseM3dStations([{ id: 'x', coord: ['139', '35'], title: { ja: 'x' } }])).toBeNull();
    expect(parseM3dRailways([{ id: 'x', title: { ja: 'x' } }])).toBeNull();
    expect(parseM3dTrains([{ id: 'x.Weekday', t: 'x', r: 'y', tt: [{ s: 1 }] }])).toBeNull();
    expect(parseM3dTrains([{ ...train('Weekday', SIMPLE_CALLS), ds: 'x' }])).toBeNull();
  });
});
