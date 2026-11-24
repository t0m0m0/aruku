import { describe, expect, it } from 'vitest';

import { compileTimetable, type LatLng, type StopCall, type Timetable } from '../src/exact-scan';
import {
  findRideDepartures,
  parseRideDeparturesQuery,
  RIDE_DEPARTURES_MAX_LEGS,
  RIDE_DEPARTURES_MAX_PER_LEG,
  type RideDeparturesDay,
  type RideDeparturesRequest,
} from '../src/ride-departures';

const EARTH_RADIUS_KM = 6371.0088;
const pointAtKm = (km: number): LatLng => ({
  lat: 35 + (km / EARTH_RADIUS_KM) * (180 / Math.PI),
  lng: 139.7,
});
const t = (hh: number, mm: number): number => hh * 3600 + mm * 60;

const call = (stop: number, at: number, o: Partial<StopCall> = {}): StopCall => ({
  stop,
  arr: at,
  dep: at,
  canBoard: true,
  canAlight: true,
  ...o,
});

const FEEDS = [{ id: 'Toei', fetchedAt: '2026-10-22T19:23:00.000Z' }];

function dayOf(
  stopKms: number[],
  trips: { route: string; calls: StopCall[] }[],
): RideDeparturesDay {
  const tt: Timetable = {
    stops: stopKms.map((km, i) => ({ name: `S${i}`, ...pointAtKm(km) })),
    trips: trips.map(({ route, calls }) => ({ route, headsign: null, calls })),
  };
  return {
    compiled: compileTimetable(tt),
    stops: tt.stops,
    feeds: FEEDS,
  };
}

const departAt = new Date('2026-11-26T12:00:00+09:00');

const req = (legs: RideDeparturesRequest['legs'], untilMin = 90): RideDeparturesRequest => ({
  departAt,
  untilMin,
  legs,
});

const deps = (day: RideDeparturesDay | null) => ({ day: () => Promise.resolve(day) });

describe('findRideDepartures', () => {
  it('乗車駅に停まって乗れ、その先の降車駅で降りられる列車を発車順に返す', async () => {
    const day = dayOf(
      [0, 5, 10],
      [
        { route: '甲線', calls: [call(0, t(12, 20)), call(1, t(12, 28)), call(2, t(12, 36))] },
        { route: '甲線', calls: [call(0, t(12, 10)), call(1, t(12, 18)), call(2, t(12, 26))] },
        { route: '甲線', calls: [call(2, t(12, 15)), call(1, t(12, 23)), call(0, t(12, 31))] },
      ],
    );

    const res = await findRideDepartures(
      req([{ board: pointAtKm(0), alight: pointAtKm(10), fromMin: 0 }]),
      deps(day),
    );

    expect(res?.legs[0].departures).toEqual([
      {
        route: '甲線',
        headsign: null,
        from: 'S0',
        to: 'S2',
        boardAt: '2026-11-26T12:10:00+09:00',
        alightAt: '2026-11-26T12:26:00+09:00',
      },
      {
        route: '甲線',
        headsign: null,
        from: 'S0',
        to: 'S2',
        boardAt: '2026-11-26T12:20:00+09:00',
        alightAt: '2026-11-26T12:36:00+09:00',
      },
    ]);
    expect(res?.legs[0].truncated).toBe(false);
    expect(res?.feeds).toEqual(FEEDS);
  });

  it('区間ごとの最早の乗車時刻より前と、時間帯の終わりより後に出る列車は返さない', async () => {
    const trip = (dep: number) => ({
      route: '甲線',
      calls: [call(0, dep), call(1, dep + 600)],
    });
    const day = dayOf([0, 5], [trip(t(12, 5)), trip(t(12, 15)), trip(t(12, 40)), trip(t(13, 1))]);

    const res = await findRideDepartures(
      req([{ board: pointAtKm(0), alight: pointAtKm(5), fromMin: 10 }], 60),
      deps(day),
    );

    expect(res?.legs[0].departures.map((d) => d.boardAt)).toEqual([
      '2026-11-26T12:15:00+09:00',
      '2026-11-26T12:40:00+09:00',
    ]);
  });

  it('乗車できない停車と、降車できない停車は使わない', async () => {
    const day = dayOf(
      [0, 5],
      [
        { route: '甲線', calls: [call(0, t(12, 10), { canBoard: false }), call(1, t(12, 20))] },
        { route: '甲線', calls: [call(0, t(12, 15)), call(1, t(12, 25), { canAlight: false })] },
        { route: '甲線', calls: [call(0, t(12, 30)), call(1, t(12, 40))] },
      ],
    );

    const res = await findRideDepartures(
      req([{ board: pointAtKm(0), alight: pointAtKm(5), fromMin: 0 }]),
      deps(day),
    );

    expect(res?.legs[0].departures.map((d) => d.boardAt)).toEqual(['2026-11-26T12:30:00+09:00']);
  });

  it('座標から離れた駅は乗降駅とみなさず、該当が無い区間は空で返す', async () => {
    const day = dayOf([0, 5], [{ route: '甲線', calls: [call(0, t(12, 10)), call(1, t(12, 20))] }]);

    const res = await findRideDepartures(
      req([
        { board: pointAtKm(1), alight: pointAtKm(5), fromMin: 0 },
        { board: pointAtKm(0), alight: pointAtKm(5), fromMin: 0 },
      ]),
      deps(day),
    );

    expect(res?.legs[0]).toEqual({ departures: [], truncated: false });
    expect(res?.legs[1].departures).toHaveLength(1);
  });

  it('同じ駅に事業者ごとの停車場所が並んでいても、近くの停車場所をすべて乗降駅として拾う', async () => {
    const day = dayOf(
      [0, 0.05, 5, 5.05],
      [
        { route: '甲線', calls: [call(0, t(12, 10)), call(2, t(12, 20))] },
        { route: '乙線', calls: [call(1, t(12, 12)), call(3, t(12, 21))] },
      ],
    );

    const res = await findRideDepartures(
      req([{ board: pointAtKm(0), alight: pointAtKm(5), fromMin: 0 }]),
      deps(day),
    );

    expect(res?.legs[0].departures.map((d) => d.route)).toEqual(['甲線', '乙線']);
  });

  it('0 時を越えて走る列車は、翌日の時刻で返す', async () => {
    const day = dayOf([0, 5], [{ route: '甲線', calls: [call(0, t(23, 55)), call(1, t(24, 5))] }]);

    const res = await findRideDepartures(
      {
        departAt: new Date('2026-11-26T23:50:00+09:00'),
        untilMin: 30,
        legs: [{ board: pointAtKm(0), alight: pointAtKm(5), fromMin: 0 }],
      },
      deps(day),
    );

    expect(res?.legs[0].departures[0].alightAt).toEqual('2026-11-27T00:05:00+09:00');
  });

  it('1 区間に返す本数は上限で打ち切り、打ち切ったことを示す', async () => {
    const trips = Array.from({ length: RIDE_DEPARTURES_MAX_PER_LEG + 3 }, (_, i) => ({
      route: '甲線',
      calls: [call(0, t(12, 0) + i * 60), call(1, t(12, 5) + i * 60)],
    }));
    const day = dayOf([0, 5], trips);

    const res = await findRideDepartures(
      req([{ board: pointAtKm(0), alight: pointAtKm(5), fromMin: 0 }], 120),
      deps(day),
    );

    expect(res?.legs[0].departures).toHaveLength(RIDE_DEPARTURES_MAX_PER_LEG);
    expect(res?.legs[0].truncated).toBe(true);
  });

  it('その日のパックが無ければ null を返す', async () => {
    const res = await findRideDepartures(
      req([{ board: pointAtKm(0), alight: pointAtKm(5), fromMin: 0 }]),
      deps(null),
    );

    expect(res).toBeNull();
  });
});

describe('parseRideDeparturesQuery', () => {
  const now = new Date('2026-11-24T12:00:00+09:00');
  const base = {
    departAt: '2026-11-26T12:00:00+09:00',
    untilMin: '90',
    legs: '35.1,139.7,35.2,139.8,0;35.2,139.8,35.3,139.9,25',
  };

  it('出発時刻・時間帯の長さ・区間（乗車駅・降車駅・最早の乗車までの分）を読む', () => {
    expect(parseRideDeparturesQuery(base, now)).toEqual({
      departAt: new Date('2026-11-26T03:00:00Z'),
      untilMin: 90,
      legs: [
        { board: { lat: 35.1, lng: 139.7 }, alight: { lat: 35.2, lng: 139.8 }, fromMin: 0 },
        { board: { lat: 35.2, lng: 139.8 }, alight: { lat: 35.3, lng: 139.9 }, fromMin: 25 },
      ],
    });
  });

  it.each([
    ['departAt にオフセットが無い', { departAt: '2026-11-26T12:00:00' }],
    ['departAt が 92 日より先', { departAt: '2027-03-01T12:00:00+09:00' }],
    ['untilMin が整数でない', { untilMin: '1.5' }],
    ['untilMin が 1 日を超える', { untilMin: '1441' }],
    ['legs が空', { legs: '' }],
    ['区間の値が 5 つでない', { legs: '35.1,139.7,35.2,139.8' }],
    ['座標が範囲外', { legs: '95,139.7,35.2,139.8,0' }],
    ['最早の乗車までの分が時間帯を越える', { legs: '35.1,139.7,35.2,139.8,91' }],
    ['最早の乗車までの分が負', { legs: '35.1,139.7,35.2,139.8,-1' }],
    [
      '区間が多すぎる',
      {
        legs: Array.from(
          { length: RIDE_DEPARTURES_MAX_LEGS + 1 },
          () => '35.1,139.7,35.2,139.8,0',
        ).join(';'),
      },
    ],
  ])('%s なら error を返す', (_name, patch) => {
    expect(parseRideDeparturesQuery({ ...base, ...patch }, now)).toHaveProperty('error');
  });
});
