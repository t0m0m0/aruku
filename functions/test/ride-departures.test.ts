import { describe, expect, it } from 'vitest';

import { compileTimetable, type LatLng, type StopCall, type Timetable } from '../src/exact-scan';
import {
  findRideDeparture,
  parseRideDepartureQuery,
  RIDE_LOOKAHEAD_MIN,
  type RideDepartureRequest,
  type RideDeparturesDay,
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
  stops: { name: string; km: number }[],
  trips: { route: string; calls: StopCall[] }[],
): RideDeparturesDay {
  const tt: Timetable = {
    stops: stops.map(({ name, km }) => ({ name, ...pointAtKm(km) })),
    trips: trips.map(({ route, calls }) => ({ route, headsign: null, calls })),
  };
  return { compiled: compileTimetable(tt), stops: tt.stops, feeds: FEEDS };
}

const line3 = (route = '甲線') =>
  dayOf(
    [
      { name: '一の駅', km: 0 },
      { name: '二の駅', km: 5 },
      { name: '三の駅', km: 10 },
    ],
    [
      { route, calls: [call(0, t(12, 20)), call(1, t(12, 28)), call(2, t(12, 36))] },
      { route, calls: [call(0, t(12, 10)), call(1, t(12, 18)), call(2, t(12, 26))] },
      { route, calls: [call(2, t(12, 15)), call(1, t(12, 23)), call(0, t(12, 31))] },
    ],
  );

const req = (o: Partial<RideDepartureRequest> = {}): RideDepartureRequest => ({
  at: new Date('2026-11-26T12:00:00+09:00'),
  board: pointAtKm(0),
  alight: pointAtKm(10),
  boardName: '一の駅',
  alightName: '三の駅',
  line: '甲線',
  ...o,
});

const deps = (day: RideDeparturesDay | null) => ({ day: () => Promise.resolve(day) });

describe('findRideDeparture', () => {
  it('乗れる列車のうち、着くのがいちばん早い 1 本だけを返す', async () => {
    const res = await findRideDeparture(req(), deps(line3()));

    expect(res).toEqual({
      ride: {
        route: '甲線',
        headsign: null,
        from: '一の駅',
        to: '三の駅',
        boardAt: '2026-11-26T12:10:00+09:00',
        alightAt: '2026-11-26T12:26:00+09:00',
      },
      feeds: FEEDS,
    });
  });

  it('後に出ても先に着く列車（急行）を採る', async () => {
    const day = dayOf(
      [
        { name: 'A', km: 0 },
        { name: 'B', km: 5 },
      ],
      [
        { route: '甲線', calls: [call(0, t(12, 6)), call(1, t(12, 30))] },
        { route: '甲線', calls: [call(0, t(12, 8)), call(1, t(12, 20))] },
      ],
    );

    const res = await findRideDeparture(
      req({ alight: pointAtKm(5), boardName: 'A', alightName: 'B' }),
      deps(day),
    );

    expect(res?.ride?.boardAt).toEqual('2026-11-26T12:08:00+09:00');
  });

  it('指定の時刻より前に出る列車には乗らない', async () => {
    const res = await findRideDeparture(
      req({ at: new Date('2026-11-26T12:11:00+09:00') }),
      deps(line3()),
    );

    expect(res?.ride?.boardAt).toEqual('2026-11-26T12:20:00+09:00');
  });

  it('乗車できない停車と、降車できない停車は使わない', async () => {
    const day = dayOf(
      [
        { name: 'A', km: 0 },
        { name: 'B', km: 5 },
      ],
      [
        { route: '甲線', calls: [call(0, t(12, 10), { canBoard: false }), call(1, t(12, 20))] },
        { route: '甲線', calls: [call(0, t(12, 15)), call(1, t(12, 25), { canAlight: false })] },
        { route: '甲線', calls: [call(0, t(12, 30)), call(1, t(12, 40))] },
      ],
    );

    const res = await findRideDeparture(
      req({ alight: pointAtKm(5), boardName: 'A', alightName: 'B' }),
      deps(day),
    );

    expect(res?.ride?.boardAt).toEqual('2026-11-26T12:30:00+09:00');
  });

  it('駅名が合えば、座標が数百 m ずれていても同じ駅とみなす', async () => {
    const res = await findRideDeparture(
      req({ board: pointAtKm(0.45), alight: pointAtKm(10.45) }),
      deps(line3()),
    );

    expect(res?.ride?.from).toEqual('一の駅');
  });

  it('駅名の「駅」と空白・かっこ書きの違いは無視する', async () => {
    const res = await findRideDeparture(
      req({ boardName: '一の 駅', alightName: '三の（東京都）' }),
      deps(line3()),
    );

    expect(res?.ride).not.toBeNull();
  });

  it('駅名が合わない近くの別の駅は、乗降駅とみなさない', async () => {
    const res = await findRideDeparture(req({ boardName: '別の駅' }), deps(line3()));

    expect(res?.ride).toBeNull();
  });

  it('駅名が分からないときは、その路線の停車場所のうち最も近い駅を乗降駅とみなす（1km まで）', async () => {
    const near = await findRideDeparture(
      req({ boardName: '', alightName: '', board: pointAtKm(0.45), alight: pointAtKm(10.45) }),
      deps(line3()),
    );
    const far = await findRideDeparture(
      req({ boardName: '', alightName: '', board: pointAtKm(-1.2) }),
      deps(line3()),
    );

    expect([near?.ride?.from, near?.ride?.to]).toEqual(['一の駅', '三の駅']);
    expect(far?.ride).toBeNull();
  });

  it('駅名が分からないとき、より近くても別の路線の駅は乗降駅にしない', async () => {
    const day = dayOf(
      [
        { name: '甲の駅', km: 0 },
        { name: '乙の駅', km: 0.1 },
        { name: '甲の終点', km: 5 },
        { name: '乙の終点', km: 5.1 },
      ],
      [
        { route: '甲線', calls: [call(0, t(12, 30)), call(2, t(12, 40))] },
        { route: '乙線', calls: [call(1, t(12, 5)), call(3, t(12, 15))] },
      ],
    );

    const res = await findRideDeparture(
      req({ boardName: '', alightName: '', board: pointAtKm(0.1), alight: pointAtKm(5.1) }),
      deps(day),
    );

    expect([res?.ride?.from, res?.ride?.boardAt]).toEqual(['甲の駅', '2026-11-26T12:30:00+09:00']);
  });

  it('駅名が分からないとき、降車駅は列車の停車駅のうち座標に最も近い駅にする', async () => {
    const day = dayOf(
      [
        { name: 'A', km: 0 },
        { name: 'B', km: 4.4 },
        { name: 'C', km: 5.2 },
      ],
      [{ route: '甲線', calls: [call(0, t(12, 10)), call(1, t(12, 18)), call(2, t(12, 20))] }],
    );

    const res = await findRideDeparture(
      req({ boardName: '', alightName: '', board: pointAtKm(0), alight: pointAtKm(5) }),
      deps(day),
    );

    expect(res?.ride?.to).toEqual('C');
  });

  it('駅名が分からないとき、降車駅を列車ごとに選ばず、座標に最も近い 1 駅に止まる列車だけを比べる', async () => {
    const day = dayOf(
      [
        { name: 'A', km: 0 },
        { name: 'B', km: 5 },
        { name: 'C', km: 5.6 },
      ],
      [
        { route: '甲線', calls: [call(0, t(12, 10)), call(1, t(12, 30))] },
        { route: '甲線', calls: [call(0, t(12, 5)), call(2, t(12, 20))] },
      ],
    );

    const res = await findRideDeparture(
      req({ boardName: '', alightName: '', board: pointAtKm(0), alight: pointAtKm(5) }),
      deps(day),
    );

    expect([res?.ride?.to, res?.ride?.alightAt]).toEqual(['B', '2026-11-26T12:30:00+09:00']);
  });

  it('路線名は事業者名の前置きだけを許して突き合わせ、別の路線の列車は採らない', async () => {
    const day = line3('東横線');

    const prefixed = await findRideDeparture(req({ line: '東急東横線' }), deps(day));
    const other = await findRideDeparture(req({ line: '目黒線' }), deps(day));
    const contains = await findRideDeparture(req({ line: '東横' }), deps(day));

    expect(prefixed?.ride?.route).toEqual('東横線');
    expect(other?.ride).toBeNull();
    expect(contains?.ride).toBeNull();
  });

  it(`着が時刻から ${RIDE_LOOKAHEAD_MIN} 分より後になる列車しか無ければ返さない（その後に出る列車が先に着くかもしれない）`, async () => {
    const day = dayOf(
      [
        { name: 'A', km: 0 },
        { name: 'B', km: 5 },
      ],
      [{ route: '甲線', calls: [call(0, t(13, 50)), call(1, t(14, 10))] }],
    );

    const res = await findRideDeparture(
      req({ alight: pointAtKm(5), boardName: 'A', alightName: 'B' }),
      deps(day),
    );

    expect(res?.ride).toBeNull();
  });

  it('0 時を越えて走る列車は、翌日の時刻で返す', async () => {
    const day = dayOf(
      [
        { name: 'A', km: 0 },
        { name: 'B', km: 5 },
      ],
      [{ route: '甲線', calls: [call(0, t(23, 55)), call(1, t(24, 5))] }],
    );

    const res = await findRideDeparture(
      req({
        at: new Date('2026-11-26T23:50:00+09:00'),
        alight: pointAtKm(5),
        boardName: 'A',
        alightName: 'B',
      }),
      deps(day),
    );

    expect(res?.ride?.alightAt).toEqual('2026-11-27T00:05:00+09:00');
  });

  it('その日のパックが無ければ null を返す', async () => {
    expect(await findRideDeparture(req(), deps(null))).toBeNull();
  });
});

describe('parseRideDepartureQuery', () => {
  const now = new Date('2026-11-24T12:00:00+09:00');
  const base = {
    at: '2026-11-26T12:00:00+09:00',
    board: '35.1,139.7',
    alight: '35.2,139.8',
    boardName: '渋谷',
    alightName: '横浜',
    line: '東急東横線',
  };

  it('時刻・乗降駅の座標と名前・路線名を読む', () => {
    expect(parseRideDepartureQuery(base, now)).toEqual({
      at: new Date('2026-11-26T03:00:00Z'),
      board: { lat: 35.1, lng: 139.7 },
      alight: { lat: 35.2, lng: 139.8 },
      boardName: '渋谷',
      alightName: '横浜',
      line: '東急東横線',
    });
  });

  it('駅名は省ける', () => {
    const { boardName: _b, alightName: _a, ...rest } = base;
    expect(parseRideDepartureQuery(rest, now)).toMatchObject({ boardName: '', alightName: '' });
  });

  it.each([
    ['at にオフセットが無い', { at: '2026-11-26T12:00:00' }],
    ['at が 92 日より先', { at: '2027-03-01T12:00:00+09:00' }],
    ['board が無い', { board: '' }],
    ['座標が範囲外', { alight: '95,139.8' }],
    ['路線名が無い', { line: '' }],
    ['路線名が長すぎる', { line: 'x'.repeat(65) }],
    ['駅名が長すぎる', { boardName: 'x'.repeat(65) }],
  ])('%s なら error を返す', (_name, patch) => {
    expect(parseRideDepartureQuery({ ...base, ...patch }, now)).toHaveProperty('error');
  });
});
