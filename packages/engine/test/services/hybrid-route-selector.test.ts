// 移植元: test/core/services/hybrid_route_selector_test.dart

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType } from '../../src/models/route-plan';
import {
  RouteCandidate,
  haversineKm,
  maxWalkBoardingIndex,
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

/// 時刻表（発着時刻）を持つ電車区間。乗車待ちを到着時刻に算入できる（#121）。
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
    const fullWalk = candidate([walk(92)]); // 予算超過
    const hybridFar = candidate([walk(25), train(5)]); // 計30
    const hybridNear = candidate([walk(15), train(7)]); // 計22
    const standard = candidate([walk(5), train(7)]); // 計12

    const best = selectBestRoute({
      candidates: [fullWalk, hybridFar, hybridNear, standard],
      budgetMin: 30,
    });

    expect(best).toBe(hybridFar);
    expect(best.walkMinutes).toEqual(25);
  });

  it('best-effort: 翌朝始発など乗車待ちが予算超過の電車より全徒歩を優先する（#121 原因②）', () => {
    const departureAt = dateTime(2026, 6, 14, 1, 0); // 終電後 01:00
    // 翌朝5:30発：駅まで徒歩5分→4時間25分待って乗車→6:00着（実到着300分）。
    const nextMorningTrain = candidate([
      walk(5),
      timedTrain(dateTime(2026, 6, 14, 5, 30), dateTime(2026, 6, 14, 6, 0)),
    ]);
    // 全徒歩：実到着360分（電車より遅い）。
    const fullWalk = candidate([walk(360, { km: 28.0 })]);

    const best = selectBestRoute({
      candidates: [nextMorningTrain, fullWalk],
      budgetMin: 60,
      departureAt,
    });

    // 実到着は電車(300)<全徒歩(360)だが、乗車待ち265分>予算なので全徒歩を優先。
    expect(best).toBe(fullWalk);
  });

  it('best-effort: 今夜乗れる電車（乗車待ち予算内）は全徒歩より早ければ優先する（#121 原因②）', () => {
    const departureAt = dateTime(2026, 6, 14, 22, 0); // 22:00
    // 徒歩5分→22:10発(待ち5分)/22:50着（実到着50分）。乗車待ちは予算内。
    const tonightTrain = candidate([
      walk(5),
      timedTrain(dateTime(2026, 6, 14, 22, 10), dateTime(2026, 6, 14, 22, 50)),
    ]);
    // 全徒歩：実到着90分。
    const fullWalk = candidate([walk(90, { km: 7.0 })]);

    const best = selectBestRoute({
      candidates: [tonightTrain, fullWalk],
      budgetMin: 30,
      departureAt,
    });

    // 乗車待ち5分は予算内なので電車を後回しにせず、実到着の早い電車を返す。
    expect(best).toBe(tonightTrain);
  });

  it('best-effort: 最初の電車に乗れても後続が翌朝始発なら全徒歩を優先する（#121 原因②）', () => {
    const departureAt = dateTime(2026, 6, 14, 22, 0); // 22:00
    // 徒歩5分→22:10発(待ち5分)/22:30着→徒歩5分→翌朝5:30発(待ち415分)/6:00着。
    // 最初の電車は乗れるが、乗り換え後の電車が翌朝始発で「今夜乗れない」。
    const overnightHybrid = candidate([
      walk(5),
      timedTrain(dateTime(2026, 6, 14, 22, 10), dateTime(2026, 6, 14, 22, 30)),
      walk(5),
      timedTrain(dateTime(2026, 6, 15, 5, 30), dateTime(2026, 6, 15, 6, 0)),
    ]);
    // 全徒歩：実到着500分（電車経路の実到着480分より遅い）。
    const fullWalk = candidate([walk(500, { km: 38.0 })]);

    const best = selectBestRoute({
      candidates: [overnightHybrid, fullWalk],
      budgetMin: 60,
      departureAt,
    });

    // 実到着は電車経路(480)<全徒歩(500)だが、後続電車の乗車待ち415分>予算なので
    // 全徒歩を優先する（最初の電車の待ち5分だけ見て取りこぼさない）。
    expect(best).toBe(fullWalk);
  });

  it('best-effort: 発車後に駅着＝乗り遅れる電車は全徒歩を優先する（#121 乗り遅れ）', () => {
    const departureAt = dateTime(2026, 6, 14, 2, 23); // 深夜 02:23
    // 徒歩10分（02:33着）だが電車は 02:30 発で既に出ている＝乗り遅れ。乗車待ちは
    // 0 に見えるため楽観到着65分は全徒歩120分より早いが、実際には乗れないので
    // best-effort では全徒歩を優先しなければならない。
    const missedTrain = candidate([
      walk(10),
      timedTrain(dateTime(2026, 6, 14, 2, 30), dateTime(2026, 6, 14, 3, 25)),
    ]);
    const fullWalk = candidate([walk(120, { km: 9.0 })]);

    const best = selectBestRoute({
      candidates: [missedTrain, fullWalk],
      budgetMin: 60, // 両候補とも予算超過＝best-effort
      departureAt,
    });

    // 乗り遅れ電車は「今夜乗れない」とみなし、楽観到着が早くても全徒歩を返す。
    expect(best).toBe(fullWalk);
  });

  it('untimed電車が予算内なら徒歩最大として選ぶ（#67 維持）', () => {
    // 日中の untimed電車（時刻表なし）でも、徒歩最大のハイブリッドを通常どおり選ぶ。
    const departureAt = dateTime(2026, 6, 14, 9, 0);
    const hybrid = candidate([walk(40), train(11), walk(30)]);
    const fullWalk = candidate([walk(60, { km: 4.0 })]);

    const best = selectBestRoute({
      candidates: [hybrid, fullWalk],
      budgetMin: 120, // 両方予算内 → 徒歩最大(70分)のハイブリッド
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
    const a = candidate([walk(10), train(15)]); // 計25
    const b = candidate([walk(10), train(8)]); // 計18

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
    const moreWalkAndTransfers = candidate([
      walk(10),
      train(5),
      walk(10),
      train(5),
    ]);
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
    const exact = candidate([walk(20), train(10)]); // 計30
    const under = candidate([walk(12), train(10)]); // 計22

    const best = selectBestRoute({ candidates: [under, exact], budgetMin: 30 });

    expect(best).toBe(exact);
  });

  it('逆戻り（目的地と逆方向）の電車区間を含む候補は、直進候補があれば選ばない', () => {
    const origin = new GeoPoint(35.5, 139.5);
    const goal = new GeoPoint(35.7, 139.5); // 出発地の北

    // 逆戻り: 出発地より南（目的地と逆方向）の駅を経由する。徒歩は多いが迂回。
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

    // 直進: 目的地方向（北）へ進む駅のみ。徒歩は少ない。
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

    // フィルタ無しなら徒歩最大の backtrack が選ばれるが、逆戻りは除外される。
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

    // 全候補が逆戻り → 除外せず予算内最短（25分）を残す。
    expect(best).toBe(shortDetour);
  });

  it('逆戻り閾値の境界: 閾値以内の後退は採用、超過は除外', () => {
    // origin→goal は緯度0.50度ぶん北向き（直線距離 D）。
    // maxBacktrackRatio=0.10 なら後退の許容は 0.10×D = 緯度0.05度ぶん。
    const origin = new GeoPoint(35.5, 139.5);
    const goal = new GeoPoint(36.0, 139.5);

    const back = (stationLat: number) =>
      candidate([
        walk(20), // 徒歩最大: フィルタ無しなら必ず選ばれる
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

    // 35.46 は origin(35.50)より 0.04度 後退 → 許容内(0.05度)で採用される。
    const withinBack = back(35.46);
    const within = selectBestRoute({
      candidates: [withinBack, straight],
      budgetMin: 60,
      origin,
      goal,
      maxBacktrackRatio: 0.1,
    });
    expect(within).toBe(withinBack);

    // 35.44 は 0.06度 後退 → 許容(0.05度)超過で除外され、直進が選ばれる。
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
    const goal = new GeoPoint(35.7, 139.5); // 北。直線距離 D=緯度0.20度。

    // 線路追従の密な polyline（200頂点）。乗車直後（index 1..5）だけ大きく南へ
    // カーブし、それ以外は goal へ単調北上する。生の全頂点判定では index 1..5 が
    // -0.15D を超える後退として誤除外されるが、逆戻り判定は両端＋均等サンプリング
    // （最大32点）で行うためこれらの一過性頂点を拾わず、逆戻り扱いしない
    // （gtfsShape 系の東急/小田急/京王での誤除外を防ぐ・#137）。
    const dense: GeoPoint[] = [];
    for (let i = 0; i < 200; i++) {
      dense.push(
        i >= 1 && i <= 5
          ? new GeoPoint(35.3, 139.5) // 0.20度 南＝大きく後退
          : new GeoPoint(35.5 + ((35.7 - 35.5) * i) / 199, 139.5),
      );
    }

    const backtrackish = candidate([
      walk(20), // 徒歩最大: フィルタ無しなら必ず選ばれる
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

    // 一過性の後方頂点はサンプリングで無視 → 徒歩最大の backtrackish が残る。
    expect(best).toBe(backtrackish);
  });

  it('departureAt 指定時は待ち時間込みの実到着で予算内を判定する', () => {
    // 9:00 出発・予算30分（締切 9:30）。
    // A: 徒歩10分(9:10着)→電車 9:25発/9:35着。待ち抜き計20分だが、乗車前
    //    待ち15分込みの実到着は 9:35＝35分で超過。徒歩は多い。
    // B: 徒歩4分(9:04着)→電車 9:05発/9:28着。実到着 9:28＝28分で間に合う。
    //    徒歩は少ないが締切内。
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

    // 待ち抜きなら徒歩最大の lateButMoreWalk が選ばれるが、実到着では超過。
    // 締切内の onTimeLessWalk（徒歩は短いが間に合う）を提示する。
    expect(best).toBe(onTimeLessWalk);
  });

  it('departureAt 指定で締切内が皆無なら実到着が最早の候補へ縮退する', () => {
    // 9:00 出発・予算20分（締切 9:20）。両候補とも超過。
    // 待ち抜き合計は longWait の方が短いが、実到着は earlier の方が早い。
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
        arrTime: dateTime(2026, 5, 22, 9, 25), // 実到着 25分
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
        arrTime: dateTime(2026, 5, 22, 9, 35), // 実到着 35分（待ち抜きは15分）
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

    // origin/goal を渡さなければ従来どおり徒歩最大が選ばれる。
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
      Math.abs(
        haversineKm(new GeoPoint(35.7, 139.7), new GeoPoint(35.7, 139.7)) - 0,
      ),
    ).toBeLessThanOrEqual(1e-9);
  });

  it('既知の2点間距離（東京駅〜品川駅 約6.8km）', () => {
    // 東京駅 35.681, 139.767 / 品川駅 35.628, 139.738
    const d = haversineKm(
      new GeoPoint(35.681, 139.767),
      new GeoPoint(35.628, 139.738),
    );
    expect(Math.abs(d - 6.4)).toBeLessThanOrEqual(0.6);
  });
});

describe('maxWalkBoardingIndex', () => {
  // 実機プローブ（蒲田→上野公園・180分）の到着分。index 昇順で単調増加。
  // 予算180分では index6(170)が予算内の最遠＝総徒歩最大、index7(181)は予算外。
  const totals = [67, 91, 118, 126, 140, 154, 170, 181, 188];

  it('予算内の最遠 index（=総徒歩最大）を返す', async () => {
    const i = await maxWalkBoardingIndex({
      count: totals.length,
      budgetMin: 180,
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(6);
  });

  it('単調性を使い評価回数を二分探索オーダーに抑える', async () => {
    let calls = 0;
    await maxWalkBoardingIndex({
      count: totals.length,
      budgetMin: 180,
      evaluate: async (index) => {
        calls++;
        return totals[index];
      },
    });
    // 全 9 件の線形評価ではなく ceil(log2(9))=4 前後で収束する。
    expect(calls).toBeLessThanOrEqual(5);
  });

  it('全候補が予算内なら末尾 index を返す', async () => {
    const i = await maxWalkBoardingIndex({
      count: totals.length,
      budgetMin: 999,
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(totals.length - 1);
  });

  it('先頭のみ予算内なら index 0', async () => {
    const i = await maxWalkBoardingIndex({
      count: totals.length,
      budgetMin: 80, // 67<=80<91
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(0);
  });

  it('予算内候補が皆無なら null', async () => {
    const i = await maxWalkBoardingIndex({
      count: totals.length,
      budgetMin: 50, // 先頭 67 すら超過
      evaluate: async (index) => totals[index],
    });
    expect(i).toBeNull();
  });

  it('候補が空なら null（評価を呼ばない）', async () => {
    let calls = 0;
    const i = await maxWalkBoardingIndex({
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
});

describe('maxWalkBoardingIndexParallel', () => {
  // 直列版と同じ実機プローブデータ（蒲田→上野公園・180分）。index 昇順で単調増加。
  const totals = [67, 91, 118, 126, 140, 154, 170, 181, 188];

  it('単調データで直列版と同じ境界（予算内の最遠 index）を返す', async () => {
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
      budgetMin: 80, // 67<=80<91
      evaluate: async (index) => totals[index],
    });
    expect(i).toEqual(0);
  });

  it('予算内候補が皆無なら null', async () => {
    const i = await maxWalkBoardingIndexParallel({
      count: totals.length,
      budgetMin: 50, // 先頭 67 すら超過
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
    // 最初のラウンド（区間0..8の4等分点 {2,4,6}）が同時に投げられている。
    // 直列二分探索なら in-flight は常に1。
    expect(pending.size).toBeGreaterThanOrEqual(2);
    // 以降はラウンドごとに解決して完走させる。
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
    // fanout=3 なら 9 点は ceil(log4(9))=2 ラウンド ×3 点以内で収束する。
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
    // 直列版と同じ二分探索の軌道: mid=4→6→7→(区間枯れ) の順。打ち切りラウンド（#332）は
    // `span < fanout` 条件なので fanout=1 では span=0 のときだけ発火し、そのときの
    // probe は内点分割と同一点になるため軌道は変わらない。
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
    // 区間0..8を4等分 {2,4,6} が全て予算内→区間7..8、span=1<fanout=3 で末尾を一括。
    expect(rounds).toEqual(2);
  });

  it('onRound は shouldContinue で打ち切られたラウンドを数えない', async () => {
    // 打ち切りは「新しいラウンドを起こさない」動作なので、起こさなかったものを
    // 段数に数えると壁時計と対応しなくなる。
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
    // 崩壊時 board-search の律速はラウンド間直列 guidance。壁時計 = ラウンド数 × 最遅1本
    // なのでラウンド数が短縮の的。matrix プレ実測で刈ったフロンティア区間（~36点・境界を
    // index20 に置く）を、fanout=3 と 5 で走らせてラウンド数を数える。
    const roundsFor = async (fanout: number): Promise<number> => {
      const pending = new Map<number, Deferred<number | null>>();
      const future = maxWalkBoardingIndexParallel({
        count: 36,
        budgetMin: 20, // 到着=index として index<=20 を予算内にする
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
      expect(
        await future,
        '境界(予算内の最遠 index)は fanout に依らず不変',
      ).toEqual(20);
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
          c.complete(index); // 到着=index
        }
        await delay(0);
      }
      return { rounds, best: await future };
    };

    it('残り全 index が fanout 本以内なら1ラウンドで打ち切る', async () => {
      // 5点・全点予算内。内点 lo+span*j/(fanout+1) は hi を含まないので、分割を
      // 続けると末尾 index4 のためだけに2ラウンド目（上流 guidance 1本ぶんの壁時計）
      // が要る。全点を1ラウンドで打てば1ラウンドで済む。
      const r = await run({ count: 5, budgetMin: 999 });
      expect(r.best).toEqual(4);
      expect(r.rounds).toEqual(1);
    });

    it('打ち切りラウンドでも境界（予算内の最遠 index）は変わらない', async () => {
      // 全点予算内でない区間でも、返す index は「予算内の最遠」のまま。
      const r = await run({ count: 5, budgetMin: 3 });
      expect(r.best).toEqual(3);
    });

    it('1ラウンドの同時発行は fanout 本を超えない', async () => {
      // 上流のレート制限が未知で、429 は「予算外」と誤認されて徒歩を静かに縮める
      // （#333）。打ち切りラウンドが fanout+1 本を撃つと、電車系+バス系の2 base 並列で
      // documented な fanout×2 の上限を破る。
      const inflight: number[] = [];
      const pending = new Map<number, Deferred<number | null>>();
      const future = maxWalkBoardingIndexParallel({
        count: 40,
        budgetMin: 999, // 全点予算内＝区間が縮みきるまで回す
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
      // 36点・境界20 は #317 の軌道（2ラウンド）を保つ＝打ち切りが広い区間の
      // 分割を壊していないことの反証。
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
        // 全点が予算内＝打ち切らなければ末尾 8 まで境界が伸びる予算にする。
        // 6 で止まることが「新ラウンドを起こしていない」ことの反証になる。
        budgetMin: 999,
        shouldContinue: () => rounds++ < 1,
        evaluate: async (index) => {
          evaluated.push(index);
          return totals[index];
        },
      });

      // 1ラウンド目（区間0..8の4等分点 {2,4,6}）だけを評価して確定している。
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
    // 「その地点から予算内で行けない」と「その地点を評価できなかった」は別物。
    // 後者（上流の 429/TIMEOUT）を予算外として扱うと、単調性を仮定した探索は
    // その先すべてを対象から外す＝境界を実測ではなく上流の調子が決める。
    it('未評価 probe は境界を手前へ動かさない', async () => {
      // 区間0..8の4等分点 {2,4,6} のうち index2 が未評価。残る 4/6 は予算内なので
      // 境界は評価できた点だけで奥（6）まで伸びる。予算外扱いなら index2 で走査が
      // 打ち切られて区間が 0..1 へ畳まれ、境界は 1 まで落ちる。
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 180,
        evaluate: async (index) => (index === 2 ? null : totals[index]),
      });
      expect(i).toEqual(6);
    });

    it('未評価が混ざっても予算外 probe は従来どおり境界を確定する', async () => {
      // 退行の反証: 未評価を無視する変更が「予算外も無視」に化けていないこと。
      // budget=130 で index4(140) は予算外。index2 が未評価でも境界は 3 に決まる。
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 130,
        evaluate: async (index) => (index === 2 ? null : totals[index]),
      });
      expect(i).toEqual(3);
    });

    it('ラウンドの probe が全て未評価なら探索を打ち切る', async () => {
      // 未評価は区間を1ミリも縮めないので、打ち切らないと同じ点を再評価し続ける
      // （呼び出し側はメモ化しているので上流も叩かず永久に回る）。
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
      // 1ラウンド目で境界6を得たあと、2ラウンド目が全滅するケース。打ち切りは
      // 「そこから先を探さない」であって、確定済みの境界を捨てることではない。
      const i = await maxWalkBoardingIndexParallel({
        count: totals.length,
        budgetMin: 999, // 全点予算内＝打ち切らなければ末尾8まで伸びる
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
    // index 3(120) だけ超過 → 探索は [0,3) の3点。
    expect(walkFeasiblePrefixCount([10, 40, 80, 120], 100)).toEqual(3);
  });

  it('非単調な dip があっても予算内の最遠 index を落とさない', () => {
    // index1(200) は超過だが index2(30) は予算内。安全上界は最遠の予算内 index=2
    // → count=3（index1 は範囲に残り評価に委ねる。index3(250) は確実に予算外で刈る）。
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
    // 実機で徒歩 62分→44分 に劣化した設計の最小再現。base の「その点以降を乗り通す」
    // 所要は X→goal の**上界**（引き直しはより速い別系統・より近い終着駅を返し得る）で、
    // 刈り込みに要るのは下界。向きが逆なので、混ぜると予算内の乗車駅が範囲から消える。
    const walk1 = [10, 20, 30, 50];
    const rideRemainFromBase = [80, 70, 65, 60]; // 上界（base に乗り通す1経路）
    const budgetMin = 100;

    // 棄却された設計を、この場で組み立てて反証する（src には持ち込まない）。
    let rejected = 0;
    for (let i = 0; i < walk1.length; i++) {
      if (walk1[i] + rideRemainFromBase[i] <= budgetMin) rejected = i + 1;
    }
    expect(
      rejected,
      '上界を足すと index 3（50+60=110>100）が探索範囲から落ちる',
    ).toEqual(3);

    // 現行は t1 単独。到着 = t1 + t2 かつ t2 ≥ 0 なので `t1 ≤ 予算` は下界による
    // 刈り込みで、実到着が予算内になり得る点を落とさない。
    expect(
      walkFeasiblePrefixCount(walk1, budgetMin),
      'index 3 は t1=50 ≤ 100 なので範囲に残り、引き直しの評価に委ねられる',
    ).toEqual(4);
  });
});

// 見積り予算内候補を実測する短リスト（#315/#318）。先行実測と selectAndEnrich の
// tier 実測が同一集合・同一順序を測るための単一の並び。
describe('measureShortlist', () => {
  const departureAt = dateTime(2026, 7, 15, 9, 0);

  it('予算外を落とし徒歩降順に並べる', () => {
    const over = candidate([walk(50), train(30)]); // 計80＞60
    const walk20 = candidate([walk(20), train(10)]); // 計30
    const walk15 = candidate([walk(15), train(10)]); // 計25
    const walk10 = candidate([walk(10), train(10)]); // 計20

    const shortlist = measureShortlist({
      candidates: [walk10, over, walk20, walk15],
      budgetMin: 60,
      departureAt,
    });

    expectSameList(shortlist, [walk20, walk15, walk10]);
  });

  it('徒歩同値は実到着昇順で並べる', () => {
    const earlier = candidate([walk(10), train(5)]); // 計15
    const later = candidate([walk(10), train(20)]); // 計30

    const shortlist = measureShortlist({
      candidates: [later, earlier],
      budgetMin: 60,
      departureAt,
    });

    expectSameList(shortlist, [earlier, later]);
  });
});

// 非崩壊ルートの先行実測対象と single-pass 発火有無（#318）。見積り予算内ハイブリッドが
// 閾値以上並ぶ reject 多発ルートでは短リスト全体を、そうでなければ勝者だけを温める。
describe('prewarmFront', () => {
  const fiveInBudget = (): {
    shortlist: RouteCandidate[];
    chosen: RouteCandidate;
  } => {
    const chosen = candidate([walk(25), train(10)]); // 徒歩最大＝見積り勝者
    const b = candidate([walk(20), train(10)]);
    const c = candidate([walk(15), train(10)]);
    const d = candidate([walk(10), train(10)]);
    const e = candidate([walk(5), train(10)]);
    return { shortlist: [chosen, b, c, d, e], chosen };
  };

  it('予算内ハイブリッドが閾値以上なら短リスト全体を single-pass で温める', () => {
    const s = fiveInBudget();
    // 上位3件をハイブリッド扱い（identity 集合）。
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
    const hybrids = new Set(s.shortlist.slice(0, 2)); // 2件＜閾値3

    const r = prewarmFront({
      shortlist: s.shortlist,
      chosen: s.chosen,
      hybrids,
      singlePassHybridThreshold: 3,
      maxMeasureShortlist: 13,
    });

    expect(r.singlePass).toBe(false);
    // Option B は勝者のみ。棄却時の次候補は winner-phase の tier 実測に委ねる。
    expectSameList(r.prewarm, [s.chosen]);
  });

  it('allowSinglePass=false なら閾値以上でも勝者のみへ抑制する', () => {
    const s = fiveInBudget();
    const hybrids = new Set(s.shortlist.slice(0, 3)); // 閾値は満たす

    const r = prewarmFront({
      shortlist: s.shortlist,
      chosen: s.chosen,
      hybrids,
      singlePassHybridThreshold: 3,
      maxMeasureShortlist: 13,
      allowSinglePass: false, // 締切切れ等で広い先行実測を許さない
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
