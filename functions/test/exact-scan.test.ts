import { describe, expect, it } from 'vitest';

import {
  bestRides,
  compileTimetable,
  pickStopsToMeasure,
  type LatLng,
  type MeasuredWalks,
  type StopCall,
  type Timetable,
} from '../src/exact-scan';

const EARTH_RADIUS_KM = 6371.0088;
const pointAtKm = (km: number): LatLng => ({
  lat: 35 + (km / EARTH_RADIUS_KM) * (180 / Math.PI),
  lng: 139.7,
});
const walkSecOfKm = (km: number): number => km * 750;

const t = (hh: number, mm: number): number => hh * 3600 + mm * 60;
const min = (m: number): number => m * 60;

const call = (
  stop: number,
  at: number,
  flags: Partial<Pick<StopCall, 'canBoard' | 'canAlight'>> = {},
): StopCall => ({
  stop,
  arr: at,
  dep: at,
  canBoard: flags.canBoard ?? true,
  canAlight: flags.canAlight ?? true,
});

const timetable = (
  stopKms: number[],
  trips: { calls: StopCall[]; route?: string }[],
): Timetable => ({
  stops: stopKms.map((km, i) => ({ name: `S${i}`, ...pointAtKm(km) })),
  trips: trips.map((trip, i) => ({
    route: trip.route ?? `R${i}`,
    headsign: null,
    calls: trip.calls,
  })),
});

const measured = (
  access: Record<number, number>,
  egress: Record<number, number>,
): MeasuredWalks => ({
  access: new Map(Object.entries(access).map(([k, v]) => [Number(k), v])),
  egress: new Map(Object.entries(egress).map(([k, v]) => [Number(k), v])),
});

const query = (budgetMin: number, departAt = t(10, 0)) => ({
  origin: pointAtKm(0),
  goal: pointAtKm(20),
  departAt,
  budgetMin,
});

describe('bestRides', () => {
  it('便が無ければ空を返す', () => {
    const ct = compileTimetable(timetable([0, 10], []));

    expect(bestRides(ct, query(120), measured({ 0: min(10) }, { 1: min(10) }))).toEqual([]);
  });

  it('出発地から歩いて乗り、降りて目的地まで歩く1本を返す', () => {
    const ct = compileTimetable(
      timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(10, 50))] }]),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(25) }, { 1: min(25) }));

    expect(rides).toEqual([
      {
        trip: 0,
        board: 0,
        alight: 1,
        boardAt: t(10, 30),
        alightAt: t(10, 50),
        accessSec: min(25),
        egressSec: min(25),
        walkSec: min(50),
      },
    ]);
  });

  it('同じ駅で乗って降りる組は返さない', () => {
    const ct = compileTimetable(
      timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(10, 50))] }]),
    );

    expect(bestRides(ct, query(120), measured({ 1: min(10) }, { 1: min(10) }))).toEqual([]);
  });

  it('同じ駅に戻ってくる便でも、その駅で乗って降りる組は返さない', () => {
    const ct = compileTimetable(
      timetable([2, 18], [{ calls: [call(0, t(10, 10)), call(1, t(10, 20)), call(0, t(10, 30))] }]),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(5) }, { 0: min(10), 1: min(5) }));

    expect(rides.map((r) => [r.board, r.alight])).toEqual([[0, 1]]);
  });

  it('降車駅が乗車駅より手前になる組は返さない', () => {
    const ct = compileTimetable(
      timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(10, 50))] }]),
    );

    expect(bestRides(ct, query(120), measured({ 1: min(10) }, { 0: min(10) }))).toEqual([]);
  });

  it('歩いて着く前に発車する便には乗らず、次の便に乗る', () => {
    const ct = compileTimetable(
      timetable(
        [2, 18],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(0, t(10, 35)), call(1, t(10, 55))] },
        ],
      ),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(30) }, { 1: min(10) }));

    expect(rides.map((r) => r.trip)).toEqual([1]);
  });

  it('降車後の徒歩で締切ちょうどに着く便は返し、1分でも過ぎる便は返さない', () => {
    const tt = timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(11, 0))] }]);
    const ct = compileTimetable(tt);

    expect(bestRides(ct, query(80), measured({ 0: min(10) }, { 1: min(20) }))).toHaveLength(1);
    expect(bestRides(ct, query(80), measured({ 0: min(10) }, { 1: min(21) }))).toEqual([]);
  });

  it('乗車できない駅では乗らない', () => {
    const ct = compileTimetable(
      timetable(
        [2, 6, 18],
        [
          {
            calls: [
              call(1, t(10, 30)),
              call(0, t(10, 40), { canBoard: false }),
              call(2, t(10, 50)),
            ],
          },
        ],
      ),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(25), 1: min(20) }, { 2: min(10) }));

    expect(rides.map((r) => r.board)).toEqual([1]);
  });

  it('同じ便の中でも、歩いて着く前に発車する駅からは乗らない', () => {
    const ct = compileTimetable(
      timetable(
        [2, 6, 18],
        [{ calls: [call(1, t(10, 30)), call(0, t(10, 40)), call(2, t(10, 50))] }],
      ),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(45), 1: min(20) }, { 2: min(10) }));

    expect(rides.map((r) => r.board)).toEqual([1]);
  });

  it('便が発車順に並んでいなくても、乗れる最初の便を見落とさない', () => {
    const ct = compileTimetable(
      timetable(
        [2, 18],
        [
          { calls: [call(0, t(10, 40)), call(1, t(10, 50))] },
          { calls: [call(0, t(10, 30)), call(1, t(10, 40))] },
          { calls: [call(0, t(11, 0)), call(1, t(11, 10))] },
        ],
      ),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(35) }, { 1: min(10) }));

    expect(rides.map((r) => r.trip)).toEqual([0]);
  });

  it('降車できない駅では降りない', () => {
    const ct = compileTimetable(
      timetable(
        [2, 14, 18],
        [
          {
            calls: [
              call(0, t(10, 30)),
              call(1, t(10, 40), { canAlight: false }),
              call(2, t(10, 50)),
            ],
          },
        ],
      ),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(10) }, { 1: min(40), 2: min(10) }));

    expect(rides.map((r) => r.alight)).toEqual([2]);
  });

  it('出発地からの徒歩が駅の並びに対して単調でなくても、徒歩最大の乗車駅を取りこぼさない', () => {
    const ct = compileTimetable(
      timetable(
        [0.5, 4, 2, 6, 19],
        [
          {
            calls: [
              call(0, t(10, 10)),
              call(1, t(11, 0)),
              call(2, t(11, 10)),
              call(3, t(11, 30)),
              call(4, t(11, 50)),
            ],
          },
        ],
      ),
    );

    const rides = bestRides(
      ct,
      query(180),
      measured({ 1: min(50), 2: min(25), 3: min(75) }, { 4: min(10) }),
    );

    expect(rides[0]).toMatchObject({ board: 3, walkSec: min(85) });
  });

  it('同じ乗車駅・降車駅の組は1本にまとめ、到着の早い便を残す', () => {
    const ct = compileTimetable(
      timetable(
        [2, 18],
        [
          { calls: [call(0, t(10, 40)), call(1, t(11, 0))] },
          { calls: [call(0, t(10, 30)), call(1, t(10, 50))] },
        ],
      ),
    );

    const rides = bestRides(ct, query(120), measured({ 0: min(20) }, { 1: min(20) }));

    expect(rides.map((r) => r.trip)).toEqual([1]);
  });

  it('徒歩の長い順に並べ、同じ徒歩なら目的地への到着が早い順に並べる', () => {
    const ct = compileTimetable(
      timetable(
        [1, 3, 17, 19],
        [
          { calls: [call(1, t(10, 40)), call(2, t(11, 10))] },
          { calls: [call(0, t(10, 30)), call(3, t(10, 50))] },
          { calls: [call(0, t(10, 20)), call(2, t(10, 45))] },
        ],
      ),
    );

    const rides = bestRides(
      ct,
      query(180),
      measured({ 0: min(15), 1: min(30) }, { 2: min(15), 3: min(30) }),
    );

    expect(rides.map((r) => [r.trip, r.walkSec])).toEqual([
      [1, min(45)],
      [0, min(45)],
      [2, min(30)],
    ]);
  });

  it('徒歩が同じ組は、同じ便の中でも目的地への到着が早い方を先に並べる', () => {
    const ct = compileTimetable(
      timetable(
        [1, 3, 5, 17],
        [
          {
            calls: [call(0, t(10, 10)), call(1, t(10, 20)), call(2, t(10, 30)), call(3, t(10, 35))],
          },
        ],
      ),
    );

    const rides = bestRides(
      ct,
      query(180),
      measured({ 0: min(10), 2: min(30) }, { 1: min(30), 3: min(10) }),
    );

    expect(rides.slice(0, 2).map((r) => [r.board, r.alight])).toEqual([
      [2, 3],
      [0, 1],
    ]);
  });

  it('1本の便で結べる組が複数あれば、別々の候補として上位 k 本に入れる', () => {
    const ct = compileTimetable(
      timetable(
        [1, 2, 17, 18],
        [
          {
            calls: [call(0, t(10, 30)), call(1, t(10, 35)), call(2, t(10, 50)), call(3, t(10, 55))],
          },
        ],
      ),
    );

    const rides = bestRides(
      ct,
      query(180),
      measured({ 0: min(10), 1: min(20) }, { 2: min(20), 3: min(10) }),
      { k: 2 },
    );

    expect(rides.map((r) => [r.board, r.alight, r.walkSec])).toEqual([
      [1, 2, min(40)],
      [1, 3, min(30)],
    ]);
  });

  it('上位 k 本だけを返す', () => {
    const ct = compileTimetable(
      timetable(
        [1, 2, 3, 17],
        [
          { calls: [call(0, t(10, 30)), call(3, t(10, 50))] },
          { calls: [call(1, t(10, 30)), call(3, t(10, 50))] },
          { calls: [call(2, t(10, 30)), call(3, t(10, 50))] },
        ],
      ),
    );

    const rides = bestRides(
      ct,
      query(180),
      measured({ 0: min(10), 1: min(20), 2: min(30) }, { 3: min(10) }),
      { k: 2 },
    );

    expect(rides.map((r) => r.board)).toEqual([2, 1]);
  });
});

describe('pickStopsToMeasure', () => {
  it('乗車側と降車側を別々に選ぶと同じ便で結べない配置でも、組で選んで解ける駅を返す', () => {
    const kms = [6, 19, 1, 12];
    const ct = compileTimetable(
      timetable(kms, [
        { calls: [call(0, t(11, 30)), call(1, t(11, 50))] },
        { calls: [call(2, t(10, 30)), call(3, t(10, 50))] },
      ]),
    );
    const q = query(180);

    const picked = pickStopsToMeasure(ct, q, { maxPerSide: 1 });

    const access = Object.fromEntries(picked.boards.map((s) => [s, walkSecOfKm(kms[s])]));
    const egress = Object.fromEntries(picked.alights.map((s) => [s, walkSecOfKm(20 - kms[s])]));
    expect(bestRides(ct, q, measured(access, egress))).not.toEqual([]);
  });

  it('同じ駅に戻ってくる便では、その駅で乗って降りる組で実測の枠を使わない', () => {
    const ct = compileTimetable(
      timetable([5, 18], [{ calls: [call(0, t(11, 10)), call(1, t(11, 20)), call(0, t(11, 30))] }]),
    );

    const picked = pickStopsToMeasure(ct, query(300), { maxPerSide: 1 });

    expect(picked).toMatchObject({ boards: [0], alights: [1] });
  });

  it('同じ駅に戻ってくる便で、戻った駅で降りる組は、それより前の別の駅から乗る組として選ぶ', () => {
    const ct = compileTimetable(
      timetable(
        [5, 2, 18],
        [
          {
            calls: [
              call(1, t(10, 40)),
              call(0, t(11, 10), { canAlight: false }),
              call(2, t(11, 20)),
              call(0, t(11, 30)),
            ],
          },
        ],
      ),
    );

    const picked = pickStopsToMeasure(ct, query(300), { maxPerSide: 1 });

    expect(picked).toMatchObject({ boards: [1], alights: [0] });
  });

  it('直線の徒歩ですら発車に間に合わない駅は、実測の対象に選ばない', () => {
    const ct = compileTimetable(
      timetable(
        [8, 3, 18],
        [
          { calls: [call(0, t(10, 30)), call(2, t(10, 55))] },
          { calls: [call(1, t(10, 45)), call(2, t(11, 5))] },
        ],
      ),
    );

    const picked = pickStopsToMeasure(ct, query(180), { maxPerSide: 12 });

    expect(picked.boards).toEqual([1]);
    expect(picked.alights).toEqual([2]);
  });

  it('直線の徒歩でぎりぎり発車に間に合う駅は、実測の対象に残す', () => {
    const ct = compileTimetable(
      timetable([3, 18], [{ calls: [call(0, t(10, 38)), call(1, t(10, 58))] }]),
    );

    const picked = pickStopsToMeasure(ct, query(180), { maxPerSide: 12 });

    expect(picked.boards).toEqual([0]);
  });

  it('各側 maxPerSide 駅までに絞り、同じ駅は重ねない', () => {
    const ct = compileTimetable(
      timetable(
        [1, 2, 3, 18],
        [
          { calls: [call(0, t(10, 30)), call(3, t(10, 50))] },
          { calls: [call(1, t(10, 40)), call(3, t(11, 0))] },
          { calls: [call(2, t(10, 50)), call(3, t(11, 10))] },
          { calls: [call(2, t(11, 0)), call(3, t(11, 20))] },
        ],
      ),
    );

    const picked = pickStopsToMeasure(ct, query(180), { maxPerSide: 2 });

    expect(picked.boards).toEqual([2, 1]);
    expect(picked.alights).toEqual([3]);
  });

  it('上限で落とした駅があれば truncated を立てる', () => {
    const ct = compileTimetable(
      timetable(
        [1, 2, 18],
        [
          { calls: [call(0, t(10, 30)), call(2, t(10, 50))] },
          { calls: [call(1, t(10, 40)), call(2, t(11, 0))] },
        ],
      ),
    );

    expect(pickStopsToMeasure(ct, query(180), { maxPerSide: 1 }).truncated).toBe(true);
    expect(pickStopsToMeasure(ct, query(180), { maxPerSide: 2 }).truncated).toBe(false);
  });

  it('締切までに乗れる発車がある便の数を tripsScanned で返す', () => {
    const ct = compileTimetable(
      timetable(
        [1, 18],
        [
          { calls: [call(0, t(10, 30)), call(1, t(10, 50))] },
          { calls: [call(0, t(11, 30)), call(1, t(11, 50))] },
          { calls: [call(0, t(13, 30)), call(1, t(13, 50))] },
        ],
      ),
    );

    expect(pickStopsToMeasure(ct, query(180)).tripsScanned).toBe(2);
  });
});

describe('compileTimetable の駅ごとの発車', () => {
  const randomTimetable = (seed: number): Timetable => {
    let x = seed;
    const rand = (n: number) => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x % n;
    };
    const stops = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, ...pointAtKm(i) }));
    const trips = Array.from({ length: 300 }, (_, t) => {
      let at = rand(48) * 300;
      const calls: StopCall[] = Array.from({ length: 2 + rand(6) }, () => {
        at += rand(3) * 300;
        return { stop: rand(12), arr: at, dep: at, canBoard: rand(4) > 0, canAlight: true };
      });
      return { route: `R${t}`, headsign: null, calls };
    });
    return { stops, trips };
  };

  it('発車時刻の昇順、同じ時刻なら便・停車順の順に並び、乗車できない停車は入らない', () => {
    const tt = randomTimetable(487);

    const ct = compileTimetable(tt);

    for (let s = 0; s < tt.stops.length; s++) {
      const expected = tt.trips
        .flatMap((trip, t) => trip.calls.map((c, pos) => ({ c, t, pos })))
        .filter(({ c }) => c.stop === s && c.canBoard)
        .sort((a, b) => a.c.dep - b.c.dep || a.t - b.t || a.pos - b.pos)
        .map(({ c, t, pos }) => [t, pos, c.dep]);
      const actual = [];
      for (let i = ct.departureStart[s]; i < ct.departureStart[s + 1]; i++) {
        actual.push([ct.departureTrip[i], ct.departurePos[i], ct.departureAt[i]]);
      }
      expect(actual).toEqual(expected);
    }
  });
});
