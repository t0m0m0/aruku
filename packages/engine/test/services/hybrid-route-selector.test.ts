import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType } from '../../src/models/route-plan';
import {
  RouteCandidate,
  haversineKm,
  maxWalkBoardingIndexParallel,
  measureShortlist,
  prewarmFront,
  selectBestRoute,
  walkFeasiblePrefixCount,
} from '../../src/services/hybrid-route-selector';
import { dateTime, differenceInMinutes } from '../../src/time';
import { deferred, type Deferred } from '../support/deferred';
import { delay } from '../support/delay';
import { expectSameList } from '../support/expect';

const walk = (minutes: number, o: { km?: number } = {}) =>
  new RouteSegment({
    type: SegmentType.walk,
    fromName: 'a',
    toName: 'b',
    minutes,
    km: o.km ?? 1.0,
  });

const train = (minutes: number, o: { km?: number } = {}) =>
  new RouteSegment({
    type: SegmentType.train,
    fromName: 'b',
    toName: 'c',
    minutes,
    km: o.km ?? 5.0,
    line: 'L',
  });

const timedTrain = (dep: Date, arr: Date, o: { km?: number } = {}) =>
  new RouteSegment({
    type: SegmentType.train,
    fromName: 'b',
    toName: 'c',
    minutes: differenceInMinutes(arr, dep),
    km: o.km ?? 5.0,
    line: 'L',
    depTime: dep,
    arrTime: arr,
  });

const candidate = (segments: RouteSegment[]) =>
  new RouteCandidate({ from: '出発地', to: '目的地', segments });

function equalWalkAndArrivalCandidates(): {
  fewerTransfers: RouteCandidate;
  moreTransfers: RouteCandidate;
} {
  const fewerTransfers = candidate([
    walk(10),
    timedTrain(dateTime(2026, 7, 15, 9, 15), dateTime(2026, 7, 15, 9, 30)),
  ]);
  const moreTransfers = candidate([
    walk(5),
    timedTrain(dateTime(2026, 7, 15, 9, 10), dateTime(2026, 7, 15, 9, 15)),
    walk(5),
    timedTrain(dateTime(2026, 7, 15, 9, 25), dateTime(2026, 7, 15, 9, 30)),
  ]);
  return { fewerTransfers, moreTransfers };
}

describe('selectBestRoute', () => {
  it('全徒歩が予算内なら全徒歩（徒歩最大）を選ぶ', () => {
    const fullWalk = candidate([walk(25, { km: 2.0 })]);
    const hybrid = candidate([walk(15), train(5)]);
    const standard = candidate([walk(5), train(7)]);

    const best = selectBestRoute({
      candidates: [fullWalk, hybrid, standard],
      budgetMin: 30,
    });

    expect(best).toBe(fullWalk);
    expect(best.walkMinutes).toEqual(25);
  });

  it('予算内でハイブリッド（徒歩最大）を選ぶ', () => {
    const fullWalk = candidate([walk(92)]);
    const hybridFar = candidate([walk(25), train(5)]);
    const hybridNear = candidate([walk(15), train(7)]);
    const standard = candidate([walk(5), train(7)]);

    const best = selectBestRoute({
      candidates: [fullWalk, hybridFar, hybridNear, standard],
      budgetMin: 30,
    });

    expect(best).toBe(hybridFar);
    expect(best.walkMinutes).toEqual(25);
  });

  it('best-effort: 翌朝始発など乗車待ちが予算超過の電車より全徒歩を優先する（#121 原因②）', () => {
    const departureAt = dateTime(2026, 6, 14, 1, 0);
    const nextMorningTrain = candidate([
      walk(5),
      timedTrain(dateTime(2026, 6, 14, 5, 30), dateTime(2026, 6, 14, 6, 0)),
    ]);
    const fullWalk = candidate([walk(360, { km: 28.0 })]);

    const best = selectBestRoute({
      candidates: [nextMorningTrain, fullWalk],
      budgetMin: 60,
      departureAt,
    });

    expect(best).toBe(fullWalk);
  });

  it('best-effort: 今夜乗れる電車（乗車待ち予算内）は全徒歩より早ければ優先する（#121 原因②）', () => {
    const departureAt = dateTime(2026, 6, 14, 22, 0);
    const tonightTrain = candidate([
      walk(5),
      timedTrain(dateTime(2026, 6, 14, 22, 10), dateTime(2026, 6, 14, 22, 50)),
    ]);
    const fullWalk = candidate([walk(90, { km: 7.0 })]);

    const best = selectBestRoute({
      candidates: [tonightTrain, fullWalk],
      budgetMin: 30,
      departureAt,
    });

    expect(best).toBe(tonightTrain);
  });

  it('best-effort: 最初の電車に乗れても後続が翌朝始発なら全徒歩を優先する（#121 原因②）', () => {
    const departureAt = dateTime(2026, 6, 14, 22, 0);
    const overnightHybrid = candidate([
      walk(5),
      timedTrain(dateTime(2026, 6, 14, 22, 10), dateTime(2026, 6, 14, 22, 30)),
      walk(5),
      timedTrain(dateTime(2026, 6, 15, 5, 30), dateTime(2026, 6, 15, 6, 0)),
    ]);
    const fullWalk = candidate([walk(500, { km: 38.0 })]);

    const best = selectBestRoute({
      candidates: [overnightHybrid, fullWalk],
      budgetMin: 60,
      departureAt,
    });

    expect(best).toBe(fullWalk);
  });

  it('best-effort: 発車後に駅着＝乗り遅れる電車は全徒歩を優先する（#121 乗り遅れ）', () => {
    const departureAt = dateTime(2026, 6, 14, 2, 23);
    const missedTrain = candidate([
      walk(10),
      timedTrain(dateTime(2026, 6, 14, 2, 30), dateTime(2026, 6, 14, 3, 25)),
    ]);
    const fullWalk = candidate([walk(120, { km: 9.0 })]);

    const best = selectBestRoute({
      candidates: [missedTrain, fullWalk],
      budgetMin: 60,
      departureAt,
    });

    expect(best).toBe(fullWalk);
  });

  it('untimed電車が予算内なら徒歩最大として選ぶ（#67 維持）', () => {
    const departureAt = dateTime(2026, 6, 14, 9, 0);
    const hybrid = candidate([walk(40), train(11), walk(30)]);
    const fullWalk = candidate([walk(60, { km: 4.0 })]);

    const best = selectBestRoute({
      candidates: [hybrid, fullWalk],
      budgetMin: 120,
      departureAt,
    });

    expect(best).toBe(hybrid);
  });

  it('予算内候補が無ければ最短を選ぶ', () => {
    const long = candidate([train(200)]);
    const shortest = candidate([train(130)]);

    const best = selectBestRoute({
      candidates: [long, shortest],
      budgetMin: 120,
    });

    expect(best).toBe(shortest);
    expect(best.totalMin).toEqual(130);
  });

  it('徒歩が同じなら合計の短い方を選ぶ', () => {
    const a = candidate([walk(10), train(15)]);
    const b = candidate([walk(10), train(8)]);

    const best = selectBestRoute({ candidates: [a, b], budgetMin: 30 });

    expect(best).toBe(b);
  });

  it('徒歩時間と実到着が同じなら候補順に依存せず乗換回数が少ない方を選ぶ', () => {
    const candidates = equalWalkAndArrivalCandidates();
    const departureAt = dateTime(2026, 7, 15, 9);

    const fewerFirst = selectBestRoute({
      candidates: [candidates.fewerTransfers, candidates.moreTransfers],
      budgetMin: 30,
      departureAt,
    });
    const fewerLast = selectBestRoute({
      candidates: [candidates.moreTransfers, candidates.fewerTransfers],
      budgetMin: 30,
      departureAt,
    });

    expect(fewerFirst).toBe(candidates.fewerTransfers);
    expect(fewerLast).toBe(candidates.fewerTransfers);
  });

  it('徒歩時間に差があれば乗換回数が多くても徒歩時間最大を優先する', () => {
    const moreWalkAndTransfers = candidate([walk(10), train(5), walk(10), train(5)]);
    const fewerWalkAndTransfers = candidate([walk(15), train(5)]);

    const best = selectBestRoute({
      candidates: [fewerWalkAndTransfers, moreWalkAndTransfers],
      budgetMin: 30,
    });

    expect(best).toBe(moreWalkAndTransfers);
  });

  it('徒歩時間が同じで実到着に差があれば乗換回数が多くても早着を優先する', () => {
    const earlierWithMoreTransfers = candidate([
      walk(5),
      timedTrain(dateTime(2026, 7, 15, 9, 10), dateTime(2026, 7, 15, 9, 15)),
      walk(5),
      timedTrain(dateTime(2026, 7, 15, 9, 20), dateTime(2026, 7, 15, 9, 25)),
    ]);
    const laterWithFewerTransfers = candidate([
      walk(10),
      timedTrain(dateTime(2026, 7, 15, 9, 15), dateTime(2026, 7, 15, 9, 30)),
    ]);

    const best = selectBestRoute({
      candidates: [laterWithFewerTransfers, earlierWithMoreTransfers],
      budgetMin: 30,
      departureAt: dateTime(2026, 7, 15, 9),
    });

    expect(best).toBe(earlierWithMoreTransfers);
  });

  it('best-effortで実到着が同じなら候補順に依存せず乗換回数が少ない方を選ぶ', () => {
    const candidates = equalWalkAndArrivalCandidates();
    const departureAt = dateTime(2026, 7, 15, 9);

    const fewerFirst = selectBestRoute({
      candidates: [candidates.fewerTransfers, candidates.moreTransfers],
      budgetMin: 20,
      departureAt,
    });
    const fewerLast = selectBestRoute({
      candidates: [candidates.moreTransfers, candidates.fewerTransfers],
      budgetMin: 20,
      departureAt,
    });

    expect(fewerFirst).toBe(candidates.fewerTransfers);
    expect(fewerLast).toBe(candidates.fewerTransfers);
  });

  it('予算ちょうど（境界）は予算内として扱う', () => {
    const exact = candidate([walk(20), train(10)]);
    const under = candidate([walk(12), train(10)]);

    const best = selectBestRoute({ candidates: [under, exact], budgetMin: 30 });

    expect(best).toBe(exact);
  });

  it('逆戻り（目的地と逆方向）の電車区間を含む候補は、直進候補があれば選ばない', () => {
    const origin = new GeoPoint(35.5, 139.5);
    const goal = new GeoPoint(35.7, 139.5);

    const backtrack = candidate([
      walk(20),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '南駅',
        toName: 'goal',
        minutes: 10,
        km: 30,
        line: 'L',
        polyline: [new GeoPoint(35.3, 139.5), new GeoPoint(35.7, 139.5)],
      }),
    ]);

    const straight = candidate([
      walk(10),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '北駅',
        toName: 'goal',
        minutes: 8,
        km: 10,
        line: 'L',
        polyline: [new GeoPoint(35.6, 139.5), new GeoPoint(35.7, 139.5)],
      }),
    ]);

    const best = selectBestRoute({
      candidates: [backtrack, straight],
      budgetMin: 60,
      origin,
      goal,
    });

    expect(best).toBe(straight);
  });

  it('全候補が逆戻りなら従来どおり最短へ縮退する', () => {
    const origin = new GeoPoint(35.5, 139.5);
    const goal = new GeoPoint(35.7, 139.5);

    const detour = (minutes: number) =>
      candidate([
        new RouteSegment({
          type: SegmentType.train,
          fromName: '南駅',
          toName: 'goal',
          minutes,
          km: 30,
          line: 'L',
          polyline: [new GeoPoint(35.3, 139.5), new GeoPoint(35.7, 139.5)],
        }),
      ]);
    const longDetour = detour(40);
    const shortDetour = detour(25);

    const best = selectBestRoute({
      candidates: [longDetour, shortDetour],
      budgetMin: 30,
      origin,
      goal,
    });

    expect(best).toBe(shortDetour);
  });

  it('逆戻り閾値の境界: 閾値以内の後退は採用、超過は除外', () => {
    const origin = new GeoPoint(35.5, 139.5);
    const goal = new GeoPoint(36.0, 139.5);

    const back = (stationLat: number) =>
      candidate([
        walk(20),
        new RouteSegment({
          type: SegmentType.train,
          fromName: '後退駅',
          toName: 'goal',
          minutes: 10,
          km: 30,
          line: 'L',
          polyline: [new GeoPoint(stationLat, 139.5), goal],
        }),
      ]);
    const straight = candidate([walk(5), train(8)]);

    const withinBack = back(35.46);
    const within = selectBestRoute({
      candidates: [withinBack, straight],
      budgetMin: 60,
      origin,
      goal,
      maxBacktrackRatio: 0.1,
    });
    expect(within).toBe(withinBack);

    const over = selectBestRoute({
      candidates: [back(35.44), straight],
      budgetMin: 60,
      origin,
      goal,
      maxBacktrackRatio: 0.1,
    });
    expect(over).toBe(straight);
  });

  it('密な gtfsShape polyline の一過性後方頂点では逆戻り除外しない（サンプリング）', () => {
    const origin = new GeoPoint(35.5, 139.5);
    const goal = new GeoPoint(35.7, 139.5);

    const dense: GeoPoint[] = [];
    for (let i = 0; i < 200; i++) {
      dense.push(
        i >= 1 && i <= 5
          ? new GeoPoint(35.3, 139.5)
          : new GeoPoint(35.5 + ((35.7 - 35.5) * i) / 199, 139.5),
      );
    }

    const backtrackish = candidate([
      walk(20),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '乗車駅',
        toName: 'goal',
        minutes: 10,
        km: 30,
        line: 'L',
        polyline: dense,
      }),
    ]);
    const straight = candidate([walk(5), train(8)]);

    const best = selectBestRoute({
      candidates: [backtrackish, straight],
      budgetMin: 60,
      origin,
      goal,
    });

    expect(best).toBe(backtrackish);
  });

  it('departureAt 指定時は待ち時間込みの実到着で予算内を判定する', () => {
    const lateButMoreWalk = candidate([
      walk(10),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 10,
        km: 5,
        line: 'L',
        depTime: dateTime(2026, 5, 22, 9, 25),
        arrTime: dateTime(2026, 5, 22, 9, 35),
      }),
    ]);
    const onTimeLessWalk = candidate([
      walk(4),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 23,
        km: 5,
        line: 'L',
        depTime: dateTime(2026, 5, 22, 9, 5),
        arrTime: dateTime(2026, 5, 22, 9, 28),
      }),
    ]);

    const best = selectBestRoute({
      candidates: [lateButMoreWalk, onTimeLessWalk],
      budgetMin: 30,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(best).toBe(onTimeLessWalk);
  });

  it('departureAt 指定で締切内が皆無なら実到着が最早の候補へ縮退する', () => {
    const earlier = candidate([
      walk(5),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 20,
        km: 5,
        line: 'L',
        depTime: dateTime(2026, 5, 22, 9, 5),
        arrTime: dateTime(2026, 5, 22, 9, 25),
      }),
    ]);
    const longWait = candidate([
      walk(5),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 10,
        km: 5,
        line: 'L',
        depTime: dateTime(2026, 5, 22, 9, 25),
        arrTime: dateTime(2026, 5, 22, 9, 35),
      }),
    ]);

    const best = selectBestRoute({
      candidates: [earlier, longWait],
      budgetMin: 20,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(best).toBe(earlier);
  });

  it('origin/goal 未指定なら方向フィルタを掛けない（後方互換）', () => {
    const goal = new GeoPoint(35.7, 139.5);
    const backtrack = candidate([
      walk(20),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '南駅',
        toName: 'goal',
        minutes: 10,
        km: 30,
        line: 'L',
        polyline: [new GeoPoint(35.3, 139.5), goal],
      }),
    ]);
    const straight = candidate([walk(10), train(8)]);

    const best = selectBestRoute({
      candidates: [backtrack, straight],
      budgetMin: 60,
    });

    expect(best).toBe(backtrack);
  });
});

describe('RouteCandidate.transferCount', () => {
  it('時刻なし区間でもtransit区間数から乗換回数を下限0で導出する', () => {
    const allWalk = candidate([walk(10), walk(5)]);
    const singleTransit = candidate([walk(5), train(10), walk(5)]);
    const twoTransitsWithWalk = candidate([train(5), walk(10), train(5)]);

    expect(allWalk.transferCount).toEqual(0);
    expect(singleTransit.transferCount).toEqual(0);
    expect(twoTransitsWithWalk.transferCount).toEqual(1);
  });
});

describe('haversineKm', () => {
  it('同一点は0', () => {
    expect(
      Math.abs(haversineKm(new GeoPoint(35.7, 139.7), new GeoPoint(35.7, 139.7)) - 0),
    ).toBeLessThanOrEqual(1e-9);
  });

  it('既知の2点間距離（東京駅〜品川駅 約6.8km）', () => {
    const d = haversineKm(new GeoPoint(35.681, 139.767), new GeoPoint(35.628, 139.738));
    expect(Math.abs(d - 6.4)).toBeLessThanOrEqual(0.6);
  });
});

describe('maxWalkBoardingIndexParallel', () => {
  const totals = [67, 91, 118, 126, 140, 154, 170, 181, 188];

  it('単調データで予算内の最遠 index を返す', async () => {
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 180,
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(6);
  });

  it('全候補が予算内なら末尾 index を返す', async () => {
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 999,
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(totals.length - 1);
  });

  it('先頭のみ予算内なら index 0', async () => {
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 80,
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(0);
  });

  it('予算内候補が皆無なら null', async () => {
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 50,
      evaluate: async (index) => totals[index],
    });
    expect(i).toBeNull();
  });

  it('候補が空なら null（評価を呼ばない）', async () => {
    let calls = 0;
    const i = await maxWalkBoardingIndexParallel({
      count: 0,
      budgetMin: 180,
      evaluate: async () => {
        calls++;
        return 0;
      },
    });
    expect(i).toBeNull();
    expect(calls).toEqual(0);
  });

  it('各ラウンドの評価を並列に投げる（複数点が同時に in-flight）', async () => {
    const pending = new Map<number, Deferred<number | null>>();
    const future = maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 180,
      evaluate: (index) => {
        const c = deferred<number | null>();
        pending.set(index, c);
        return c.promise;
      },
    });
    await delay(0);
    expect(pending.size).toBeGreaterThanOrEqual(2);
    while (pending.size > 0) {
      const round = [...pending.entries()];
      pending.clear();
      for (const [index, c] of round) {
        c.complete(totals[index]);
      }
      await delay(0);
    }
    expect(await future).toEqual(6);
  });

  it('評価回数はラウンド数×fanout に収まり、同一 index を二度評価しない', async () => {
    const evaluated: number[] = [];
    await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 180,
      evaluate: async (index) => {
        evaluated.push(index);
        return totals[index];
      },
    });
    expect(evaluated.length).toBeLessThanOrEqual(6);
    expect(new Set(evaluated).size, '重複評価なし').toEqual(evaluated.length);
  });

  it('fanout=1 は直列二分探索と同一の挙動（中点1点ずつ）', async () => {
    const evaluated: number[] = [];
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 180,
      fanout: 1,
      evaluate: async (index) => {
        evaluated.push(index);
        return totals[index];
      },
    });
    expect(i).toEqual(6);
    expect(evaluated).toEqual([4, 6, 7]);
  });

  it('onRound はラウンド（＝直列 guidance の段数）ごとに1回だけ呼ばれる', async () => {
    let rounds = 0;
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 180,
      onRound: () => {
        rounds++;
      },
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(6);
    expect(rounds).toEqual(2);
  });

  it('onRound は shouldContinue で打ち切られたラウンドを数えない', async () => {
    let rounds = 0;
    await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 180,
      shouldContinue: () => false,
      onRound: () => {
        rounds++;
      },
      evaluate: async (index) => totals[index],
    });
    expect(rounds).toEqual(0);
  });

  it('fanout 拡大でラウンド数（直列 guidance の段数）が減る（#317）', async () => {
    const roundsFor = async (fanout: number): Promise<number> => {
      const pending = new Map<number, Deferred<number | null>>();
      const future = maxWalkBoardingIndexParallel({
        count: 36,
        budgetMin: 20,
        fanout,
        evaluate: (index) => {
          const c = deferred<number | null>();
          pending.set(index, c);
          return c.promise;
        },
      });
      await delay(0);
      let rounds = 0;
      while (pending.size > 0) {
        rounds++;
        const batch = [...pending.entries()];
        pending.clear();
        for (const [index, c] of batch) {
          c.complete(index);
        }
        await delay(0);
      }
      expect(await future, '境界(予算内の最遠 index)は fanout に依らず不変').toEqual(20);
      return rounds;
    };

    const r3 = await roundsFor(3);
    const r5 = await roundsFor(5);
    expect(r3).toEqual(3);
    expect(r5, 'fanout=5 なら同区間が1ラウンド少なく収束する').toEqual(2);
  });

  describe('打ち切りラウンド (#332)', () => {
    const run = async (args: {
      count: number;
      budgetMin: number;
      fanout?: number;
    }): Promise<{ rounds: number; best: number | null }> => {
      const pending = new Map<number, Deferred<number | null>>();
      const future = maxWalkBoardingIndexParallel({
        count: args.count,
        budgetMin: args.budgetMin,
        fanout: args.fanout ?? 5,
        evaluate: (index) => {
          const c = deferred<number | null>();
          pending.set(index, c);
          return c.promise;
        },
      });
      await delay(0);
      let rounds = 0;
      while (pending.size > 0) {
        rounds++;
        const batch = [...pending.entries()];
        pending.clear();
        for (const [index, c] of batch) {
          c.complete(index);
        }
        await delay(0);
      }
      return { rounds, best: await future };
    };

    it('残り全 index が fanout 本以内なら1ラウンドで打ち切る', async () => {
      const r = await run({ count: 5, budgetMin: 999 });
      expect(r.best).toEqual(4);
      expect(r.rounds).toEqual(1);
    });

    it('打ち切りラウンドでも境界（予算内の最遠 index）は変わらない', async () => {
      const r = await run({ count: 5, budgetMin: 3 });
      expect(r.best).toEqual(3);
    });

    it('1ラウンドの同時発行は fanout 本を超えない', async () => {
      const inflight: number[] = [];
      const pending = new Map<number, Deferred<number | null>>();
      const future = maxWalkBoardingIndexParallel({
        count: 40,
        budgetMin: 999,
        fanout: 5,
        evaluate: (index) => {
          const c = deferred<number | null>();
          pending.set(index, c);
          return c.promise;
        },
      });
      await delay(0);
      while (pending.size > 0) {
        inflight.push(pending.size);
        const batch = [...pending.entries()];
        pending.clear();
        for (const [index, c] of batch) {
          c.complete(index);
        }
        await delay(0);
      }
      await future;
      expect(
        inflight.every((n) => n <= 5),
        `同時発行: ${inflight.join(',')}`,
      ).toBe(true);
    });

    it('区間が fanout より広いラウンドは従来どおり内点分割する', async () => {
      const r = await run({ count: 36, budgetMin: 20 });
      expect(r.best).toEqual(20);
      expect(r.rounds).toEqual(2);
    });
  });

  describe('shouldContinue による打ち切り (#300)', () => {
    it('打ち切り後は新ラウンドを起こさず、既得の境界を返す', async () => {
      const evaluated: number[] = [];
      let rounds = 0;
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 999,
        shouldContinue: () => rounds++ < 1,
        evaluate: async (index) => {
          evaluated.push(index);
          return totals[index];
        },
      });

      expect(evaluated).toEqual([2, 4, 6]);
      expect(i).toEqual(6);
    });

    it('打ち切らなければ同じ条件で末尾まで境界が伸びる', async () => {
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 999,
        evaluate: async (index) => totals[index],
      });

      expect(i).toEqual(totals.length - 1);
    });

    it('最初から打ち切られていれば評価を1回も呼ばず null', async () => {
      let calls = 0;
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 180,
        shouldContinue: () => false,
        evaluate: async (index) => {
          calls++;
          return totals[index];
        },
      });

      expect(i).toBeNull();
      expect(calls).toEqual(0);
    });
  });

  describe('未評価 probe の分離 (#333)', () => {
    it('未評価 probe は境界を手前へ動かさない', async () => {
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 180,
        evaluate: async (index) => (index === 2 ? null : totals[index]),
      });
      expect(i).toEqual(6);
    });

    it('未評価が混ざっても予算外 probe は従来どおり境界を確定する', async () => {
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 130,
        evaluate: async (index) => (index === 2 ? null : totals[index]),
      });
      expect(i).toEqual(3);
    });

    it('ラウンドの probe が全て未評価なら探索を打ち切る', async () => {
      const evaluated: number[] = [];
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 180,
        evaluate: async (index) => {
          evaluated.push(index);
          if (evaluated.length > 50) {
            throw new Error(`全未評価で打ち切っていない: ${evaluated.join(',')}`);
          }
          return null;
        },
      });
      expect(i, '境界の情報が1つも得られていない').toBeNull();
      expect(evaluated, '1ラウンドだけ評価して抜ける').toEqual([2, 4, 6]);
    });

    it('全未評価で打ち切っても既得の境界は返す', async () => {
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 999,
        evaluate: async (index) => (index >= 7 ? null : totals[index]),
      });
      expect(i).toEqual(6);
    });
  });
});

describe('walkFeasiblePrefixCount', () => {
  it('全点が予算内なら全長を返す', () => {
    expect(walkFeasiblePrefixCount([10, 30, 60, 90], 100)).toEqual(4);
  });

  it('末尾が予算超過なら予算内の最遠 index+1 を返す', () => {
    expect(walkFeasiblePrefixCount([10, 40, 80, 120], 100)).toEqual(3);
  });

  it('非単調な dip があっても予算内の最遠 index を落とさない', () => {
    expect(walkFeasiblePrefixCount([10, 200, 30, 250], 100)).toEqual(3);
  });

  it('先頭すら予算超過なら 0（探索しない）', () => {
    expect(walkFeasiblePrefixCount([150, 200], 100)).toEqual(0);
  });

  it('空なら 0', () => {
    expect(walkFeasiblePrefixCount([], 100)).toEqual(0);
  });

  it('境界値（walk1 == budget）は予算内に含める', () => {
    expect(walkFeasiblePrefixCount([50, 100, 101], 100)).toEqual(2);
  });

  it('刈り込みの判断材料は t1 だけで、base 由来の乗車残余を混ぜない（#332 棄却①）', () => {
    const walk1 = [10, 20, 30, 50];
    const rideRemainFromBase = [80, 70, 65, 60];
    const budgetMin = 100;

    let rejected = 0;
    for (let i = 0; i < walk1.length; i++) {
      if (walk1[i] + rideRemainFromBase[i] <= budgetMin) rejected = i + 1;
    }
    expect(rejected, '上界を足すと index 3（50+60=110>100）が探索範囲から落ちる').toEqual(3);

    expect(
      walkFeasiblePrefixCount(walk1, budgetMin),
      'index 3 は t1=50 ≤ 100 なので範囲に残り、引き直しの評価に委ねられる',
    ).toEqual(4);
  });
});

describe('measureShortlist', () => {
  const departureAt = dateTime(2026, 7, 15, 9, 0);

  it('予算外を落とし徒歩降順に並べる', () => {
    const over = candidate([walk(50), train(30)]);
    const walk20 = candidate([walk(20), train(10)]);
    const walk15 = candidate([walk(15), train(10)]);
    const walk10 = candidate([walk(10), train(10)]);

    const shortlist = measureShortlist({
      candidates: [walk10, over, walk20, walk15],
      budgetMin: 60,
      departureAt,
    });

    expectSameList(shortlist, [walk20, walk15, walk10]);
  });

  it('徒歩同値は実到着昇順で並べる', () => {
    const earlier = candidate([walk(10), train(5)]);
    const later = candidate([walk(10), train(20)]);

    const shortlist = measureShortlist({
      candidates: [later, earlier],
      budgetMin: 60,
      departureAt,
    });

    expectSameList(shortlist, [earlier, later]);
  });
});

describe('prewarmFront', () => {
  const fiveInBudget = (): {
    shortlist: RouteCandidate[];
    chosen: RouteCandidate;
  } => {
    const chosen = candidate([walk(25), train(10)]);
    const b = candidate([walk(20), train(10)]);
    const c = candidate([walk(15), train(10)]);
    const d = candidate([walk(10), train(10)]);
    const e = candidate([walk(5), train(10)]);
    return { shortlist: [chosen, b, c, d, e], chosen };
  };

  it('予算内ハイブリッドが閾値以上なら短リスト全体を single-pass で温める', () => {
    const s = fiveInBudget();
    const hybrids = new Set(s.shortlist.slice(0, 3));

    const r = prewarmFront({
      shortlist: s.shortlist,
      chosen: s.chosen,
      hybrids,
      singlePassHybridThreshold: 3,
      maxMeasureShortlist: 13,
    });

    expect(r.singlePass).toBe(true);
    expectSameList(r.prewarm, s.shortlist);
  });

  it('予算内ハイブリッドが閾値未満なら勝者だけを温める', () => {
    const s = fiveInBudget();
    const hybrids = new Set(s.shortlist.slice(0, 2));

    const r = prewarmFront({
      shortlist: s.shortlist,
      chosen: s.chosen,
      hybrids,
      singlePassHybridThreshold: 3,
      maxMeasureShortlist: 13,
    });

    expect(r.singlePass).toBe(false);
    expectSameList(r.prewarm, [s.chosen]);
  });

  it('allowSinglePass=false なら閾値以上でも勝者のみへ抑制する', () => {
    const s = fiveInBudget();
    const hybrids = new Set(s.shortlist.slice(0, 3));

    const r = prewarmFront({
      shortlist: s.shortlist,
      chosen: s.chosen,
      hybrids,
      singlePassHybridThreshold: 3,
      maxMeasureShortlist: 13,
      allowSinglePass: false,
    });

    expect(r.singlePass).toBe(false);
    expectSameList(r.prewarm, [s.chosen]);
  });

  it('single-pass の温め対象は maxMeasureShortlist 件で頭打ち', () => {
    const many: RouteCandidate[] = [];
    for (let i = 0; i < 15; i++) {
      many.push(candidate([walk(30 - i), train(10)]));
    }
    const hybrids = new Set(many);

    const r = prewarmFront({
      shortlist: many,
      chosen: many[0],
      hybrids,
      singlePassHybridThreshold: 3,
      maxMeasureShortlist: 13,
    });

    expect(r.singlePass).toBe(true);
    expect(r.prewarm.length).toEqual(13);
    expectSameList(r.prewarm, many.slice(0, 13));
  });
});
