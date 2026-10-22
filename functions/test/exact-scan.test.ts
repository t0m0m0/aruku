import { describe, expect, it } from "vitest";

import {
  bestRides,
  compileTimetable,
  pickStopsToMeasure,
  type LatLng,
  type MeasuredWalks,
  type StopCall,
  type Timetable,
} from "../src/exact-scan";

// 同じ経線上に km 単位で点を置く。経線に沿った大円距離は緯度差そのものなので、
// 2点の直線距離が km の差にちょうど一致する（ハバーサインの近似誤差を持ち込まない）。
const EARTH_RADIUS_KM = 6371.0088;
const pointAtKm = (km: number): LatLng => ({
  lat: 35 + (km / EARTH_RADIUS_KM) * (180 / Math.PI),
  lng: 139.7,
});
// 80 m/分で歩いたときの秒数。1 km = 750 秒。
const walkSecOfKm = (km: number): number => km * 750;

const t = (hh: number, mm: number): number => hh * 3600 + mm * 60;
const min = (m: number): number => m * 60;

const call = (
  stop: number,
  at: number,
  flags: Partial<Pick<StopCall, "canBoard" | "canAlight">> = {},
): StopCall => ({
  stop,
  arr: at,
  dep: at,
  canBoard: flags.canBoard ?? true,
  canAlight: flags.canAlight ?? true,
});

// 駅を km の位置で並べ、便を停車列で与える小さな時刻表。
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

describe("bestRides", () => {
  it("便が無ければ空を返す", () => {
    const ct = compileTimetable(timetable([0, 10], []));

    expect(bestRides(ct, query(120), measured({ 0: min(10) }, { 1: min(10) }))).toEqual([]);
  });

  it("出発地から歩いて乗り、降りて目的地まで歩く1本を返す", () => {
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

  it("同じ駅で乗って降りる組は返さない", () => {
    const ct = compileTimetable(
      timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(10, 50))] }]),
    );

    // 実測があるのは駅1だけ。駅1で乗って駅1で降りる以外に組めない
    expect(bestRides(ct, query(120), measured({ 1: min(10) }, { 1: min(10) }))).toEqual([]);
  });

  it("同じ駅に戻ってくる便でも、その駅で乗って降りる組は返さない", () => {
    const ct = compileTimetable(
      timetable(
        [2, 18],
        [{ calls: [call(0, t(10, 10)), call(1, t(10, 20)), call(0, t(10, 30))] }],
      ),
    );

    // 駅0で乗って駅0に戻る方が徒歩は長いが、乗り降りが同じ駅
    const rides = bestRides(ct, query(120), measured({ 0: min(5) }, { 0: min(10), 1: min(5) }));

    expect(rides.map((r) => [r.board, r.alight])).toEqual([[0, 1]]);
  });

  it("降車駅が乗車駅より手前になる組は返さない", () => {
    const ct = compileTimetable(
      timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(10, 50))] }]),
    );

    // 駅1で乗って駅0で降りる向きにしか実測が無い
    expect(bestRides(ct, query(120), measured({ 1: min(10) }, { 0: min(10) }))).toEqual([]);
  });

  it("歩いて着く前に発車する便には乗らず、次の便に乗る", () => {
    const ct = compileTimetable(
      timetable(
        [2, 18],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(0, t(10, 35)), call(1, t(10, 55))] },
        ],
      ),
    );

    // 駅0まで30分。10:20発には間に合わず、10:35発に乗る
    const rides = bestRides(ct, query(120), measured({ 0: min(30) }, { 1: min(10) }));

    expect(rides.map((r) => r.trip)).toEqual([1]);
  });

  it("降車後の徒歩で締切ちょうどに着く便は返し、1分でも過ぎる便は返さない", () => {
    const tt = timetable([2, 18], [{ calls: [call(0, t(10, 30)), call(1, t(11, 0))] }]);
    const ct = compileTimetable(tt);

    // 10:00発・予算80分＝締切11:20。11:00着＋20分＝11:20
    expect(bestRides(ct, query(80), measured({ 0: min(10) }, { 1: min(20) }))).toHaveLength(1);
    expect(bestRides(ct, query(80), measured({ 0: min(10) }, { 1: min(21) }))).toEqual([]);
  });

  it("乗車できない駅では乗らない", () => {
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

    // 駅0の方が徒歩は長いが乗車不可なので、手前の駅1から乗る
    const rides = bestRides(ct, query(120), measured({ 0: min(25), 1: min(20) }, { 2: min(10) }));

    expect(rides.map((r) => r.board)).toEqual([1]);
  });

  it("同じ便の中でも、歩いて着く前に発車する駅からは乗らない", () => {
    const ct = compileTimetable(
      timetable(
        [2, 6, 18],
        [{ calls: [call(1, t(10, 30)), call(0, t(10, 40)), call(2, t(10, 50))] }],
      ),
    );

    // 駅0の方が徒歩は長いが、歩いて着くのが10:45で10:40発に間に合わない
    const rides = bestRides(ct, query(120), measured({ 0: min(45), 1: min(20) }, { 2: min(10) }));

    expect(rides.map((r) => r.board)).toEqual([1]);
  });

  it("便が発車順に並んでいなくても、乗れる最初の便を見落とさない", () => {
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

    // 駅0に着くのは10:35。10:30発には乗れず、10:40発（便0）が最初に乗れる便
    const rides = bestRides(ct, query(120), measured({ 0: min(35) }, { 1: min(10) }));

    expect(rides.map((r) => r.trip)).toEqual([0]);
  });

  it("降車できない駅では降りない", () => {
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

    // 駅1で降りる方が徒歩は長いが降車不可なので、駅2で降りる
    const rides = bestRides(ct, query(120), measured({ 0: min(10) }, { 1: min(40), 2: min(10) }));

    expect(rides.map((r) => r.alight)).toEqual([2]);
  });

  it("出発地からの徒歩が駅の並びに対して単調でなくても、徒歩最大の乗車駅を取りこぼさない", () => {
    // 駅2は駅1より出発地に近い（路線が戻る）。徒歩最大の乗車駅は奥の駅3
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

  it("同じ乗車駅・降車駅の組は1本にまとめ、到着の早い便を残す", () => {
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

  it("徒歩の長い順に並べ、同じ徒歩なら目的地への到着が早い順に並べる", () => {
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

    // 徒歩45分が2本（便0: 30+15、便1: 15+30）。到着は便1が 10:50+30=11:20、便0が 11:10+15=11:25
    expect(rides.map((r) => [r.trip, r.walkSec])).toEqual([
      [1, min(45)],
      [0, min(45)],
      [2, min(30)],
    ]);
  });

  it("徒歩が同じ組は、同じ便の中でも目的地への到着が早い方を先に並べる", () => {
    const ct = compileTimetable(
      timetable(
        [1, 3, 5, 17],
        [
          {
            calls: [
              call(0, t(10, 10)),
              call(1, t(10, 20)),
              call(2, t(10, 30)),
              call(3, t(10, 35)),
            ],
          },
        ],
      ),
    );

    // 0→1 も 2→3 も徒歩40分。到着は 0→1 が 10:20+30=10:50、2→3 が 10:35+10=10:45
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

  it("1本の便で結べる組が複数あれば、別々の候補として上位 k 本に入れる", () => {
    const ct = compileTimetable(
      timetable(
        [1, 2, 17, 18],
        [
          {
            calls: [
              call(0, t(10, 30)),
              call(1, t(10, 35)),
              call(2, t(10, 50)),
              call(3, t(10, 55)),
            ],
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

    // 1→2 が40分で最大、次が 0→2 と 1→3 の30分（到着の早い 1→3 が先）
    expect(rides.map((r) => [r.board, r.alight, r.walkSec])).toEqual([
      [1, 2, min(40)],
      [1, 3, min(30)],
    ]);
  });

  it("上位 k 本だけを返す", () => {
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

describe("pickStopsToMeasure", () => {
  it("乗車側と降車側を別々に選ぶと同じ便で結べない配置でも、組で選んで解ける駅を返す", () => {
    // 便0: 出発地から遠い駅0で乗れるが、降りられるのは目的地に近い駅1だけ
    // 便1: 目的地から遠い駅3で降りられるが、乗れるのは出発地に近い駅2だけ
    // 別々に遠い順で1駅ずつ選ぶと {乗車: 駅0, 降車: 駅3} になり、どちらの便でも結べない
    const kms = [6, 19, 1, 12];
    const ct = compileTimetable(
      timetable(kms, [
        { calls: [call(0, t(11, 30)), call(1, t(11, 50))] },
        { calls: [call(2, t(10, 30)), call(3, t(10, 50))] },
      ]),
    );
    const q = query(180);

    const picked = pickStopsToMeasure(ct, q, { maxPerSide: 1 });

    // 実測は直線どおりだったとして、選ばれた駅だけで2パス目を回す
    const access = Object.fromEntries(picked.boards.map((s) => [s, walkSecOfKm(kms[s])]));
    const egress = Object.fromEntries(picked.alights.map((s) => [s, walkSecOfKm(20 - kms[s])]));
    expect(bestRides(ct, q, measured(access, egress))).not.toEqual([]);
  });

  it("同じ駅に戻ってくる便では、その駅で乗って降りる組で実測の枠を使わない", () => {
    // 駅0（5km）で乗って駅0に戻る組は直線で徒歩20km分になるが、乗り降りが同じ駅。
    // 選ぶべき組は駅0→駅1（18km）
    const ct = compileTimetable(
      timetable(
        [5, 18],
        [{ calls: [call(0, t(11, 10)), call(1, t(11, 20)), call(0, t(11, 30))] }],
      ),
    );

    const picked = pickStopsToMeasure(ct, query(300), { maxPerSide: 1 });

    expect(picked).toEqual({ boards: [0], alights: [1] });
  });

  it("同じ駅に戻ってくる便で、戻った駅で降りる組は、それより前の別の駅から乗る組として選ぶ", () => {
    // 駅1（2km）→駅0（5km・乗車のみ）→駅2（18km）→駅0 と回る便。駅0で乗って駅0で降りる組は除き、
    // 徒歩最大は駅1で乗って戻った駅0で降りる組（2km+15km）。駅0→駅2（5km+2km）より長い
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

    expect(picked).toEqual({ boards: [1], alights: [0] });
  });

  it("直線の徒歩ですら発車に間に合わない駅は、実測の対象に選ばない", () => {
    // 駅0（8km・直線で100分）は 10:30 発で、直線でも間に合わない。駅1（3km・37.5分）は 10:45 発で間に合う
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

  it("直線の徒歩でぎりぎり発車に間に合う駅は、実測の対象に残す", () => {
    // 駅0（3km・直線で37.5分）は 10:38 発。直線より長く見積もると落ちてしまう駅
    const ct = compileTimetable(
      timetable([3, 18], [{ calls: [call(0, t(10, 38)), call(1, t(10, 58))] }]),
    );

    const picked = pickStopsToMeasure(ct, query(180), { maxPerSide: 12 });

    expect(picked.boards).toEqual([0]);
  });

  it("各側 maxPerSide 駅までに絞り、同じ駅は重ねない", () => {
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
});
