import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart';
import 'package:flutter_test/flutter_test.dart';

RouteSegment _walk(int minutes, {double km = 1.0}) => RouteSegment(
  type: SegmentType.walk,
  fromName: 'a',
  toName: 'b',
  minutes: minutes,
  km: km,
);

RouteSegment _train(int minutes, {double km = 5.0}) => RouteSegment(
  type: SegmentType.train,
  fromName: 'b',
  toName: 'c',
  minutes: minutes,
  km: km,
  line: 'L',
);

/// 時刻表（発着時刻）を持つ電車区間。乗車待ちを到着時刻に算入できる（#121）。
RouteSegment _timedTrain(DateTime dep, DateTime arr, {double km = 5.0}) =>
    RouteSegment(
      type: SegmentType.train,
      fromName: 'b',
      toName: 'c',
      minutes: arr.difference(dep).inMinutes,
      km: km,
      line: 'L',
      depTime: dep,
      arrTime: arr,
    );

RouteCandidate _candidate(List<RouteSegment> segments) =>
    RouteCandidate(from: '出発地', to: '目的地', segments: segments);

({RouteCandidate fewerTransfers, RouteCandidate moreTransfers})
_equalWalkAndArrivalCandidates() {
  final fewerTransfers = _candidate([
    _walk(10),
    _timedTrain(DateTime(2026, 7, 15, 9, 15), DateTime(2026, 7, 15, 9, 30)),
  ]);
  final moreTransfers = _candidate([
    _walk(5),
    _timedTrain(DateTime(2026, 7, 15, 9, 10), DateTime(2026, 7, 15, 9, 15)),
    _walk(5),
    _timedTrain(DateTime(2026, 7, 15, 9, 25), DateTime(2026, 7, 15, 9, 30)),
  ]);
  return (fewerTransfers: fewerTransfers, moreTransfers: moreTransfers);
}

void main() {
  group('selectBestRoute', () {
    test('全徒歩が予算内なら全徒歩（徒歩最大）を選ぶ', () {
      final fullWalk = _candidate([_walk(25, km: 2.0)]);
      final hybrid = _candidate([_walk(15), _train(5)]);
      final standard = _candidate([_walk(5), _train(7)]);

      final best = selectBestRoute(
        candidates: [fullWalk, hybrid, standard],
        budgetMin: 30,
      );

      expect(best, same(fullWalk));
      expect(best.walkMinutes, 25);
    });

    test('予算内でハイブリッド（徒歩最大）を選ぶ', () {
      final fullWalk = _candidate([_walk(92)]); // 予算超過
      final hybridFar = _candidate([_walk(25), _train(5)]); // 計30
      final hybridNear = _candidate([_walk(15), _train(7)]); // 計22
      final standard = _candidate([_walk(5), _train(7)]); // 計12

      final best = selectBestRoute(
        candidates: [fullWalk, hybridFar, hybridNear, standard],
        budgetMin: 30,
      );

      expect(best, same(hybridFar));
      expect(best.walkMinutes, 25);
    });

    test('best-effort: 翌朝始発など乗車待ちが予算超過の電車より全徒歩を優先する（#121 原因②）', () {
      final departureAt = DateTime(2026, 6, 14, 1, 0); // 終電後 01:00
      // 翌朝5:30発：駅まで徒歩5分→4時間25分待って乗車→6:00着（実到着300分）。
      final nextMorningTrain = _candidate([
        _walk(5),
        _timedTrain(DateTime(2026, 6, 14, 5, 30), DateTime(2026, 6, 14, 6, 0)),
      ]);
      // 全徒歩：実到着360分（電車より遅い）。
      final fullWalk = _candidate([_walk(360, km: 28.0)]);

      final best = selectBestRoute(
        candidates: [nextMorningTrain, fullWalk],
        budgetMin: 60,
        departureAt: departureAt,
      );

      // 実到着は電車(300)<全徒歩(360)だが、乗車待ち265分>予算なので全徒歩を優先。
      expect(best, same(fullWalk));
    });

    test('best-effort: 今夜乗れる電車（乗車待ち予算内）は全徒歩より早ければ優先する（#121 原因②）', () {
      final departureAt = DateTime(2026, 6, 14, 22, 0); // 22:00
      // 徒歩5分→22:10発(待ち5分)/22:50着（実到着50分）。乗車待ちは予算内。
      final tonightTrain = _candidate([
        _walk(5),
        _timedTrain(
          DateTime(2026, 6, 14, 22, 10),
          DateTime(2026, 6, 14, 22, 50),
        ),
      ]);
      // 全徒歩：実到着90分。
      final fullWalk = _candidate([_walk(90, km: 7.0)]);

      final best = selectBestRoute(
        candidates: [tonightTrain, fullWalk],
        budgetMin: 30,
        departureAt: departureAt,
      );

      // 乗車待ち5分は予算内なので電車を後回しにせず、実到着の早い電車を返す。
      expect(best, same(tonightTrain));
    });

    test('best-effort: 最初の電車に乗れても後続が翌朝始発なら全徒歩を優先する（#121 原因②）', () {
      final departureAt = DateTime(2026, 6, 14, 22, 0); // 22:00
      // 徒歩5分→22:10発(待ち5分)/22:30着→徒歩5分→翌朝5:30発(待ち415分)/6:00着。
      // 最初の電車は乗れるが、乗り換え後の電車が翌朝始発で「今夜乗れない」。
      final overnightHybrid = _candidate([
        _walk(5),
        _timedTrain(
          DateTime(2026, 6, 14, 22, 10),
          DateTime(2026, 6, 14, 22, 30),
        ),
        _walk(5),
        _timedTrain(DateTime(2026, 6, 15, 5, 30), DateTime(2026, 6, 15, 6, 0)),
      ]);
      // 全徒歩：実到着500分（電車経路の実到着480分より遅い）。
      final fullWalk = _candidate([_walk(500, km: 38.0)]);

      final best = selectBestRoute(
        candidates: [overnightHybrid, fullWalk],
        budgetMin: 60,
        departureAt: departureAt,
      );

      // 実到着は電車経路(480)<全徒歩(500)だが、後続電車の乗車待ち415分>予算なので
      // 全徒歩を優先する（最初の電車の待ち5分だけ見て取りこぼさない）。
      expect(best, same(fullWalk));
    });

    test('best-effort: 発車後に駅着＝乗り遅れる電車は全徒歩を優先する（#121 乗り遅れ）', () {
      final departureAt = DateTime(2026, 6, 14, 2, 23); // 深夜 02:23
      // 徒歩10分（02:33着）だが電車は 02:30 発で既に出ている＝乗り遅れ。乗車待ちは
      // 0 に見えるため楽観到着65分は全徒歩120分より早いが、実際には乗れないので
      // best-effort では全徒歩を優先しなければならない。
      final missedTrain = _candidate([
        _walk(10),
        _timedTrain(DateTime(2026, 6, 14, 2, 30), DateTime(2026, 6, 14, 3, 25)),
      ]);
      final fullWalk = _candidate([_walk(120, km: 9.0)]);

      final best = selectBestRoute(
        candidates: [missedTrain, fullWalk],
        budgetMin: 60, // 両候補とも予算超過＝best-effort
        departureAt: departureAt,
      );

      // 乗り遅れ電車は「今夜乗れない」とみなし、楽観到着が早くても全徒歩を返す。
      expect(best, same(fullWalk));
    });

    test('untimed電車が予算内なら徒歩最大として選ぶ（#67 維持）', () {
      // 日中の untimed電車（時刻表なし）でも、徒歩最大のハイブリッドを通常どおり選ぶ。
      final departureAt = DateTime(2026, 6, 14, 9, 0);
      final hybrid = _candidate([_walk(40), _train(11), _walk(30)]);
      final fullWalk = _candidate([_walk(60, km: 4.0)]);

      final best = selectBestRoute(
        candidates: [hybrid, fullWalk],
        budgetMin: 120, // 両方予算内 → 徒歩最大(70分)のハイブリッド
        departureAt: departureAt,
      );

      expect(best, same(hybrid));
    });

    test('予算内候補が無ければ最短を選ぶ', () {
      final long = _candidate([_train(200)]);
      final shortest = _candidate([_train(130)]);

      final best = selectBestRoute(
        candidates: [long, shortest],
        budgetMin: 120,
      );

      expect(best, same(shortest));
      expect(best.totalMin, 130);
    });

    test('徒歩が同じなら合計の短い方を選ぶ', () {
      final a = _candidate([_walk(10), _train(15)]); // 計25
      final b = _candidate([_walk(10), _train(8)]); // 計18

      final best = selectBestRoute(candidates: [a, b], budgetMin: 30);

      expect(best, same(b));
    });

    test('徒歩時間と実到着が同じなら候補順に依存せず乗換回数が少ない方を選ぶ', () {
      final candidates = _equalWalkAndArrivalCandidates();
      final departureAt = DateTime(2026, 7, 15, 9);

      final fewerFirst = selectBestRoute(
        candidates: [candidates.fewerTransfers, candidates.moreTransfers],
        budgetMin: 30,
        departureAt: departureAt,
      );
      final fewerLast = selectBestRoute(
        candidates: [candidates.moreTransfers, candidates.fewerTransfers],
        budgetMin: 30,
        departureAt: departureAt,
      );

      expect(fewerFirst, same(candidates.fewerTransfers));
      expect(fewerLast, same(candidates.fewerTransfers));
    });

    test('徒歩時間に差があれば乗換回数が多くても徒歩時間最大を優先する', () {
      final moreWalkAndTransfers = _candidate([
        _walk(10),
        _train(5),
        _walk(10),
        _train(5),
      ]);
      final fewerWalkAndTransfers = _candidate([_walk(15), _train(5)]);

      final best = selectBestRoute(
        candidates: [fewerWalkAndTransfers, moreWalkAndTransfers],
        budgetMin: 30,
      );

      expect(best, same(moreWalkAndTransfers));
    });

    test('徒歩時間が同じで実到着に差があれば乗換回数が多くても早着を優先する', () {
      final earlierWithMoreTransfers = _candidate([
        _walk(5),
        _timedTrain(DateTime(2026, 7, 15, 9, 10), DateTime(2026, 7, 15, 9, 15)),
        _walk(5),
        _timedTrain(DateTime(2026, 7, 15, 9, 20), DateTime(2026, 7, 15, 9, 25)),
      ]);
      final laterWithFewerTransfers = _candidate([
        _walk(10),
        _timedTrain(DateTime(2026, 7, 15, 9, 15), DateTime(2026, 7, 15, 9, 30)),
      ]);

      final best = selectBestRoute(
        candidates: [laterWithFewerTransfers, earlierWithMoreTransfers],
        budgetMin: 30,
        departureAt: DateTime(2026, 7, 15, 9),
      );

      expect(best, same(earlierWithMoreTransfers));
    });

    test('best-effortで実到着が同じなら候補順に依存せず乗換回数が少ない方を選ぶ', () {
      final candidates = _equalWalkAndArrivalCandidates();
      final departureAt = DateTime(2026, 7, 15, 9);

      final fewerFirst = selectBestRoute(
        candidates: [candidates.fewerTransfers, candidates.moreTransfers],
        budgetMin: 20,
        departureAt: departureAt,
      );
      final fewerLast = selectBestRoute(
        candidates: [candidates.moreTransfers, candidates.fewerTransfers],
        budgetMin: 20,
        departureAt: departureAt,
      );

      expect(fewerFirst, same(candidates.fewerTransfers));
      expect(fewerLast, same(candidates.fewerTransfers));
    });

    test('予算ちょうど（境界）は予算内として扱う', () {
      final exact = _candidate([_walk(20), _train(10)]); // 計30
      final under = _candidate([_walk(12), _train(10)]); // 計22

      final best = selectBestRoute(candidates: [under, exact], budgetMin: 30);

      expect(best, same(exact));
    });

    test('逆戻り（目的地と逆方向）の電車区間を含む候補は、直進候補があれば選ばない', () {
      const origin = GeoPoint(35.50, 139.50);
      const goal = GeoPoint(35.70, 139.50); // 出発地の北

      // 逆戻り: 出発地より南（目的地と逆方向）の駅を経由する。徒歩は多いが迂回。
      final backtrack = _candidate([
        _walk(20),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '南駅',
          toName: 'goal',
          minutes: 10,
          km: 30,
          line: 'L',
          polyline: [GeoPoint(35.30, 139.50), GeoPoint(35.70, 139.50)],
        ),
      ]);

      // 直進: 目的地方向（北）へ進む駅のみ。徒歩は少ない。
      final straight = _candidate([
        _walk(10),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '北駅',
          toName: 'goal',
          minutes: 8,
          km: 10,
          line: 'L',
          polyline: [GeoPoint(35.60, 139.50), GeoPoint(35.70, 139.50)],
        ),
      ]);

      final best = selectBestRoute(
        candidates: [backtrack, straight],
        budgetMin: 60,
        origin: origin,
        goal: goal,
      );

      // フィルタ無しなら徒歩最大の backtrack が選ばれるが、逆戻りは除外される。
      expect(best, same(straight));
    });

    test('全候補が逆戻りなら従来どおり最短へ縮退する', () {
      const origin = GeoPoint(35.50, 139.50);
      const goal = GeoPoint(35.70, 139.50);

      RouteCandidate detour(int minutes) => _candidate([
        RouteSegment(
          type: SegmentType.train,
          fromName: '南駅',
          toName: 'goal',
          minutes: minutes,
          km: 30,
          line: 'L',
          polyline: const [GeoPoint(35.30, 139.50), GeoPoint(35.70, 139.50)],
        ),
      ]);
      final longDetour = detour(40);
      final shortDetour = detour(25);

      final best = selectBestRoute(
        candidates: [longDetour, shortDetour],
        budgetMin: 30,
        origin: origin,
        goal: goal,
      );

      // 全候補が逆戻り → 除外せず予算内最短（25分）を残す。
      expect(best, same(shortDetour));
    });

    test('逆戻り閾値の境界: 閾値以内の後退は採用、超過は除外', () {
      // origin→goal は緯度0.50度ぶん北向き（直線距離 D）。
      // maxBacktrackRatio=0.10 なら後退の許容は 0.10×D = 緯度0.05度ぶん。
      const origin = GeoPoint(35.50, 139.50);
      const goal = GeoPoint(36.00, 139.50);

      RouteCandidate back(double stationLat) => _candidate([
        _walk(20), // 徒歩最大: フィルタ無しなら必ず選ばれる
        RouteSegment(
          type: SegmentType.train,
          fromName: '後退駅',
          toName: 'goal',
          minutes: 10,
          km: 30,
          line: 'L',
          polyline: [GeoPoint(stationLat, 139.50), goal],
        ),
      ]);
      final straight = _candidate([_walk(5), _train(8)]);

      // 35.46 は origin(35.50)より 0.04度 後退 → 許容内(0.05度)で採用される。
      final withinBack = back(35.46);
      final within = selectBestRoute(
        candidates: [withinBack, straight],
        budgetMin: 60,
        origin: origin,
        goal: goal,
        maxBacktrackRatio: 0.10,
      );
      expect(within, same(withinBack));

      // 35.44 は 0.06度 後退 → 許容(0.05度)超過で除外され、直進が選ばれる。
      final over = selectBestRoute(
        candidates: [back(35.44), straight],
        budgetMin: 60,
        origin: origin,
        goal: goal,
        maxBacktrackRatio: 0.10,
      );
      expect(over, same(straight));
    });

    test('密な gtfsShape polyline の一過性後方頂点では逆戻り除外しない（サンプリング）', () {
      const origin = GeoPoint(35.50, 139.50);
      const goal = GeoPoint(35.70, 139.50); // 北。直線距離 D=緯度0.20度。

      // 線路追従の密な polyline（200頂点）。乗車直後（index 1..5）だけ大きく南へ
      // カーブし、それ以外は goal へ単調北上する。生の全頂点判定では index 1..5 が
      // -0.15D を超える後退として誤除外されるが、逆戻り判定は両端＋均等サンプリング
      // （最大32点）で行うためこれらの一過性頂点を拾わず、逆戻り扱いしない
      // （gtfsShape 系の東急/小田急/京王での誤除外を防ぐ・#137）。
      final dense = <GeoPoint>[
        for (var i = 0; i < 200; i++)
          if (i >= 1 && i <= 5)
            const GeoPoint(35.30, 139.50) // 0.20度 南＝大きく後退
          else
            GeoPoint(35.50 + (35.70 - 35.50) * i / 199, 139.50),
      ];

      final backtrackish = _candidate([
        _walk(20), // 徒歩最大: フィルタ無しなら必ず選ばれる
        RouteSegment(
          type: SegmentType.train,
          fromName: '乗車駅',
          toName: 'goal',
          minutes: 10,
          km: 30,
          line: 'L',
          polyline: dense,
        ),
      ]);
      final straight = _candidate([_walk(5), _train(8)]);

      final best = selectBestRoute(
        candidates: [backtrackish, straight],
        budgetMin: 60,
        origin: origin,
        goal: goal,
      );

      // 一過性の後方頂点はサンプリングで無視 → 徒歩最大の backtrackish が残る。
      expect(best, same(backtrackish));
    });

    test('departureAt 指定時は待ち時間込みの実到着で予算内を判定する', () {
      // 9:00 出発・予算30分（締切 9:30）。
      // A: 徒歩10分(9:10着)→電車 9:25発/9:35着。待ち抜き計20分だが、乗車前
      //    待ち15分込みの実到着は 9:35＝35分で超過。徒歩は多い。
      // B: 徒歩4分(9:04着)→電車 9:05発/9:28着。実到着 9:28＝28分で間に合う。
      //    徒歩は少ないが締切内。
      final lateButMoreWalk = _candidate([
        _walk(10),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 10,
          km: 5,
          line: 'L',
          depTime: DateTime(2026, 5, 22, 9, 25),
          arrTime: DateTime(2026, 5, 22, 9, 35),
        ),
      ]);
      final onTimeLessWalk = _candidate([
        _walk(4),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 23,
          km: 5,
          line: 'L',
          depTime: DateTime(2026, 5, 22, 9, 5),
          arrTime: DateTime(2026, 5, 22, 9, 28),
        ),
      ]);

      final best = selectBestRoute(
        candidates: [lateButMoreWalk, onTimeLessWalk],
        budgetMin: 30,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      // 待ち抜きなら徒歩最大の lateButMoreWalk が選ばれるが、実到着では超過。
      // 締切内の onTimeLessWalk（徒歩は短いが間に合う）を提示する。
      expect(best, same(onTimeLessWalk));
    });

    test('departureAt 指定で締切内が皆無なら実到着が最早の候補へ縮退する', () {
      // 9:00 出発・予算20分（締切 9:20）。両候補とも超過。
      // 待ち抜き合計は longWait の方が短いが、実到着は earlier の方が早い。
      final earlier = _candidate([
        _walk(5),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 20,
          km: 5,
          line: 'L',
          depTime: DateTime(2026, 5, 22, 9, 5),
          arrTime: DateTime(2026, 5, 22, 9, 25), // 実到着 25分
        ),
      ]);
      final longWait = _candidate([
        _walk(5),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 10,
          km: 5,
          line: 'L',
          depTime: DateTime(2026, 5, 22, 9, 25),
          arrTime: DateTime(2026, 5, 22, 9, 35), // 実到着 35分（待ち抜きは15分）
        ),
      ]);

      final best = selectBestRoute(
        candidates: [earlier, longWait],
        budgetMin: 20,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      expect(best, same(earlier));
    });

    test('origin/goal 未指定なら方向フィルタを掛けない（後方互換）', () {
      const goal = GeoPoint(35.70, 139.50);
      final backtrack = _candidate([
        _walk(20),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '南駅',
          toName: 'goal',
          minutes: 10,
          km: 30,
          line: 'L',
          polyline: [GeoPoint(35.30, 139.50), goal],
        ),
      ]);
      final straight = _candidate([_walk(10), _train(8)]);

      // origin/goal を渡さなければ従来どおり徒歩最大が選ばれる。
      final best = selectBestRoute(
        candidates: [backtrack, straight],
        budgetMin: 60,
      );

      expect(best, same(backtrack));
    });
  });

  group('RouteCandidate.transferCount', () {
    test('時刻なし区間でもtransit区間数から乗換回数を下限0で導出する', () {
      final allWalk = _candidate([_walk(10), _walk(5)]);
      final singleTransit = _candidate([_walk(5), _train(10), _walk(5)]);
      final twoTransitsWithWalk = _candidate([_train(5), _walk(10), _train(5)]);

      expect(allWalk.transferCount, 0);
      expect(singleTransit.transferCount, 0);
      expect(twoTransitsWithWalk.transferCount, 1);
    });
  });

  group('haversineKm', () {
    test('同一点は0', () {
      expect(
        haversineKm(const GeoPoint(35.7, 139.7), const GeoPoint(35.7, 139.7)),
        closeTo(0, 1e-9),
      );
    });

    test('既知の2点間距離（東京駅〜品川駅 約6.8km）', () {
      // 東京駅 35.681, 139.767 / 品川駅 35.628, 139.738
      final d = haversineKm(
        const GeoPoint(35.681, 139.767),
        const GeoPoint(35.628, 139.738),
      );
      expect(d, closeTo(6.4, 0.6));
    });
  });

  group('maxWalkBoardingIndex', () {
    // 実機プローブ（蒲田→上野公園・180分）の到着分。index 昇順で単調増加。
    // 予算180分では index6(170)が予算内の最遠＝総徒歩最大、index7(181)は予算外。
    const totals = [67, 91, 118, 126, 140, 154, 170, 181, 188];

    test('予算内の最遠 index（=総徒歩最大）を返す', () async {
      final i = await maxWalkBoardingIndex(
        count: totals.length,
        budgetMin: 180,
        evaluate: (index) async => totals[index],
      );
      expect(i, 6);
    });

    test('単調性を使い評価回数を二分探索オーダーに抑える', () async {
      var calls = 0;
      await maxWalkBoardingIndex(
        count: totals.length,
        budgetMin: 180,
        evaluate: (index) async {
          calls++;
          return totals[index];
        },
      );
      // 全 9 件の線形評価ではなく ceil(log2(9))=4 前後で収束する。
      expect(calls, lessThanOrEqualTo(5));
    });

    test('全候補が予算内なら末尾 index を返す', () async {
      final i = await maxWalkBoardingIndex(
        count: totals.length,
        budgetMin: 999,
        evaluate: (index) async => totals[index],
      );
      expect(i, totals.length - 1);
    });

    test('先頭のみ予算内なら index 0', () async {
      final i = await maxWalkBoardingIndex(
        count: totals.length,
        budgetMin: 80, // 67<=80<91
        evaluate: (index) async => totals[index],
      );
      expect(i, 0);
    });

    test('予算内候補が皆無なら null', () async {
      final i = await maxWalkBoardingIndex(
        count: totals.length,
        budgetMin: 50, // 先頭 67 すら超過
        evaluate: (index) async => totals[index],
      );
      expect(i, isNull);
    });

    test('候補が空なら null（評価を呼ばない）', () async {
      var calls = 0;
      final i = await maxWalkBoardingIndex(
        count: 0,
        budgetMin: 180,
        evaluate: (index) async {
          calls++;
          return 0;
        },
      );
      expect(i, isNull);
      expect(calls, 0);
    });
  });

  group('maxWalkBoardingIndexParallel', () {
    // 直列版と同じ実機プローブデータ（蒲田→上野公園・180分）。index 昇順で単調増加。
    const totals = [67, 91, 118, 126, 140, 154, 170, 181, 188];

    test('単調データで直列版と同じ境界（予算内の最遠 index）を返す', () async {
      final i = await maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 180,
        evaluate: (index) async => totals[index],
      );
      expect(i, 6);
    });

    test('全候補が予算内なら末尾 index を返す', () async {
      final i = await maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 999,
        evaluate: (index) async => totals[index],
      );
      expect(i, totals.length - 1);
    });

    test('先頭のみ予算内なら index 0', () async {
      final i = await maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 80, // 67<=80<91
        evaluate: (index) async => totals[index],
      );
      expect(i, 0);
    });

    test('予算内候補が皆無なら null', () async {
      final i = await maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 50, // 先頭 67 すら超過
        evaluate: (index) async => totals[index],
      );
      expect(i, isNull);
    });

    test('候補が空なら null（評価を呼ばない）', () async {
      var calls = 0;
      final i = await maxWalkBoardingIndexParallel(
        count: 0,
        budgetMin: 180,
        evaluate: (index) async {
          calls++;
          return 0;
        },
      );
      expect(i, isNull);
      expect(calls, 0);
    });

    test('各ラウンドの評価を並列に投げる（複数点が同時に in-flight）', () async {
      final pending = <int, Completer<int>>{};
      final future = maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 180,
        evaluate: (index) {
          final c = Completer<int>();
          pending[index] = c;
          return c.future;
        },
      );
      await Future<void>.delayed(Duration.zero);
      // 最初のラウンド（区間0..8の4等分点 {2,4,6}）が同時に投げられている。
      // 直列二分探索なら in-flight は常に1。
      expect(pending.length, greaterThanOrEqualTo(2));
      // 以降はラウンドごとに解決して完走させる。
      while (pending.isNotEmpty) {
        final round = [...pending.entries];
        pending.clear();
        for (final e in round) {
          e.value.complete(totals[e.key]);
        }
        await Future<void>.delayed(Duration.zero);
      }
      expect(await future, 6);
    });

    test('評価回数はラウンド数×fanout に収まり、同一 index を二度評価しない', () async {
      final evaluated = <int>[];
      await maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 180,
        evaluate: (index) async {
          evaluated.add(index);
          return totals[index];
        },
      );
      // fanout=3 なら 9 点は ceil(log4(9))=2 ラウンド ×3 点以内で収束する。
      expect(evaluated.length, lessThanOrEqualTo(6));
      expect(evaluated.toSet().length, evaluated.length, reason: '重複評価なし');
    });

    test('fanout=1 でも境界は直列二分探索と一致する（軌道は打ち切りラウンド分だけ異なる）', () async {
      final evaluated = <int>[];
      final i = await maxWalkBoardingIndexParallel(
        count: totals.length,
        budgetMin: 180,
        fanout: 1,
        evaluate: (index) async {
          evaluated.add(index);
          return totals[index];
        },
      );
      expect(i, 6);
      // 中点 4→6 まで直列版と同一。区間が [7,8]（span=1 <= fanout）へ縮んだ時点で
      // 内点分割をやめ 7・8 を同一ラウンドで打つ（#332）ため、直列版の [4,6,7] に
      // 対し 8 が1点多い。境界（予算内の最遠 index）は変わらない。
      expect(evaluated, [4, 6, 7, 8]);
    });

    test('fanout 拡大でラウンド数（直列 guidance の段数）が減る（#317）', () async {
      // 崩壊時 board-search の律速はラウンド間直列 guidance。壁時計 = ラウンド数 × 最遅1本
      // なのでラウンド数が短縮の的。matrix プレ実測で刈ったフロンティア区間（~36点・境界を
      // index20 に置く）を、fanout=3 と 5 で走らせてラウンド数を数える。
      Future<int> roundsFor(int fanout) async {
        final pending = <int, Completer<int>>{};
        final future = maxWalkBoardingIndexParallel(
          count: 36,
          budgetMin: 20, // 到着=index として index<=20 を予算内にする
          fanout: fanout,
          evaluate: (index) {
            final c = Completer<int>();
            pending[index] = c;
            return c.future;
          },
        );
        await Future<void>.delayed(Duration.zero);
        var rounds = 0;
        while (pending.isNotEmpty) {
          rounds++;
          final batch = [...pending.entries];
          pending.clear();
          for (final e in batch) {
            e.value.complete(e.key);
          }
          await Future<void>.delayed(Duration.zero);
        }
        expect(await future, 20, reason: '境界(予算内の最遠 index)は fanout に依らず不変');
        return rounds;
      }

      final r3 = await roundsFor(3);
      final r5 = await roundsFor(5);
      expect(r3, 3);
      expect(r5, 2, reason: 'fanout=5 なら同区間が1ラウンド少なく収束する');
    });

    group('打ち切りラウンド (#332)', () {
      Future<({int rounds, int? best})> run({
        required int count,
        required int budgetMin,
        int fanout = 5,
      }) async {
        final pending = <int, Completer<int>>{};
        final future = maxWalkBoardingIndexParallel(
          count: count,
          budgetMin: budgetMin,
          fanout: fanout,
          evaluate: (index) {
            final c = Completer<int>();
            pending[index] = c;
            return c.future;
          },
        );
        await Future<void>.delayed(Duration.zero);
        var rounds = 0;
        while (pending.isNotEmpty) {
          rounds++;
          final batch = [...pending.entries];
          pending.clear();
          for (final e in batch) {
            e.value.complete(e.key); // 到着=index
          }
          await Future<void>.delayed(Duration.zero);
        }
        return (rounds: rounds, best: await future);
      }

      test('区間が fanout 以下なら残り全 index を1ラウンドで打ち切る', () async {
        // 6点・全点予算内。内点 lo+span*j/(fanout+1) は hi を含まないので、分割を
        // 続けると末尾 index5 のためだけに2ラウンド目（上流 guidance 1本ぶんの壁時計）
        // が要る。span(5) <= fanout(5) の区間を全点1ラウンドで打てば1ラウンドで済む。
        final r = await run(count: 6, budgetMin: 999);
        expect(r.best, 5);
        expect(r.rounds, 1);
      });

      test('打ち切りラウンドでも境界（予算内の最遠 index）は変わらない', () async {
        // 全点予算内でない区間でも、返す index は「予算内の最遠」のまま。
        final r = await run(count: 6, budgetMin: 3);
        expect(r.best, 3);
      });

      test('区間が fanout より広いラウンドは従来どおり内点分割する', () async {
        // 36点・境界20 は #317 の軌道（2ラウンド）を保つ＝打ち切りが広い区間の
        // 分割を壊していないことの反証。
        final r = await run(count: 36, budgetMin: 20);
        expect(r.best, 20);
        expect(r.rounds, 2);
      });
    });

    group('start による探索窓 (#332)', () {
      test('start より手前の index は評価しない', () async {
        final evaluated = <int>[];
        await maxWalkBoardingIndexParallel(
          count: 36,
          start: 25,
          budgetMin: 30,
          fanout: 5,
          evaluate: (index) async {
            evaluated.add(index);
            return index;
          },
        );
        expect(evaluated, isNotEmpty);
        expect(evaluated.every((i) => i >= 25), isTrue, reason: '$evaluated');
      });

      test('窓の中に境界があれば予算内の最遠 index を返す', () async {
        final i = await maxWalkBoardingIndexParallel(
          count: 124,
          start: 28,
          budgetMin: 33, // 到着=index
          fanout: 5,
          evaluate: (index) async => index,
        );
        expect(i, 33);
      });

      test('start 以降がすべて予算外なら null（手前は探索しない）', () async {
        // 手前へ戻る回収は呼び出し側のフォールバックの責務。探索プリミティブは
        // 「渡された窓の中の最遠」だけを答える。
        final i = await maxWalkBoardingIndexParallel(
          count: 124,
          start: 40,
          budgetMin: 33,
          fanout: 5,
          evaluate: (index) async => index,
        );
        expect(i, isNull);
      });

      test('窓に絞るとラウンド数（直列 guidance の段数）が減る', () async {
        // 実機の崩壊ケース（コリドー124点・境界33・fanout=5）は全域探索で3ラウンド。
        // 予測が境界を挟む窓へ絞れれば、同じ境界へ少ないラウンドで到達する。
        Future<({int rounds, int? best})> run({
          required int start,
          required int count,
        }) async {
          final pending = <int, Completer<int>>{};
          final future = maxWalkBoardingIndexParallel(
            count: count,
            start: start,
            budgetMin: 33,
            fanout: 5,
            evaluate: (index) {
              final c = Completer<int>();
              pending[index] = c;
              return c.future;
            },
          );
          await Future<void>.delayed(Duration.zero);
          var rounds = 0;
          while (pending.isNotEmpty) {
            rounds++;
            final batch = [...pending.entries];
            pending.clear();
            for (final e in batch) {
              e.value.complete(e.key);
            }
            await Future<void>.delayed(Duration.zero);
          }
          return (rounds: rounds, best: await future);
        }

        final full = await run(start: 0, count: 124);
        final windowed = await run(start: 28, count: 40);
        expect(full.best, 33);
        expect(windowed.best, 33, reason: '窓に絞っても境界は同じ');
        expect(full.rounds, 3);
        expect(windowed.rounds, lessThan(full.rounds));
      });
    });

    group('shouldContinue による打ち切り (#300)', () {
      test('打ち切り後は新ラウンドを起こさず、既得の境界を返す', () async {
        final evaluated = <int>[];
        var rounds = 0;
        final i = await maxWalkBoardingIndexParallel(
          count: totals.length,
          // 全点が予算内＝打ち切らなければ末尾 8 まで境界が伸びる予算にする。
          // 6 で止まることが「新ラウンドを起こしていない」ことの反証になる。
          budgetMin: 999,
          shouldContinue: () => rounds++ < 1,
          evaluate: (index) async {
            evaluated.add(index);
            return totals[index];
          },
        );

        // 1ラウンド目（区間0..8の4等分点 {2,4,6}）だけを評価して確定している。
        expect(evaluated, [2, 4, 6]);
        expect(i, 6);
      });

      test('打ち切らなければ同じ条件で末尾まで境界が伸びる', () async {
        final i = await maxWalkBoardingIndexParallel(
          count: totals.length,
          budgetMin: 999,
          evaluate: (index) async => totals[index],
        );

        expect(i, totals.length - 1);
      });

      test('最初から打ち切られていれば評価を1回も呼ばず null', () async {
        var calls = 0;
        final i = await maxWalkBoardingIndexParallel(
          count: totals.length,
          budgetMin: 180,
          shouldContinue: () => false,
          evaluate: (index) async {
            calls++;
            return totals[index];
          },
        );

        expect(i, isNull);
        expect(calls, 0);
      });
    });
  });

  group('arrivalFeasiblePrefixCount', () {
    // 残り所要の下界を渡さない（全0）＝到着下界が t1 だけの場合。#317 の挙動。
    int walkOnly(List<int> walk1Min, int budgetMin) =>
        arrivalFeasiblePrefixCount(
          walk1Min: walk1Min,
          minRemainMin: [for (final _ in walk1Min) 0],
          budgetMin: budgetMin,
        );

    test('全点が予算内なら全長を返す', () {
      expect(walkOnly([10, 30, 60, 90], 100), 4);
    });

    test('末尾が予算超過なら予算内の最遠 index+1 を返す', () {
      // index 3(120) だけ超過 → 探索は [0,3) の3点。
      expect(walkOnly([10, 40, 80, 120], 100), 3);
    });

    test('非単調な dip があっても予算内の最遠 index を落とさない', () {
      // index1(200) は超過だが index2(30) は予算内。安全上界は最遠の予算内 index=2
      // → count=3（index1 は範囲に残り評価に委ねる。index3(250) は確実に予算外で刈る）。
      expect(walkOnly([10, 200, 30, 250], 100), 3);
    });

    test('先頭すら予算超過なら 0（探索しない）', () {
      expect(walkOnly([150, 200], 100), 0);
    });

    test('空なら 0', () {
      expect(walkOnly(const [], 100), 0);
    });

    test('境界値（到着下界 == budget）は予算内に含める', () {
      expect(walkOnly([50, 100, 101], 100), 2);
    });

    test('残り所要の下界を足すと探索範囲が縮む（#332）', () {
      // t1 単独では全点が予算内＝1点も刈れない（崩壊時は予算が大きく余っているので
      // これが常態）。乗車駅から goal までの残り所要 t2 の下界を足せば、t1+t2 で
      // 確実に予算外の遠点を刈れる。
      const walk1 = [10, 40, 80, 95];
      expect(walkOnly(walk1, 100), 4, reason: '前提: t1 単独では刈れない');
      expect(
        arrivalFeasiblePrefixCount(
          walk1Min: walk1,
          minRemainMin: const [60, 50, 30, 10], // 到着下界 70/90/110/105
          budgetMin: 100,
        ),
        2,
      );
    });

    test('真の下界である限り実到着が予算内の点は刈らない', () {
      // 実際の残り所要は [60,50,30] だが、下界として過小な [20,20,20] を渡した場合。
      // 実到着は 70/90/110 で予算内の最遠は index1。下界駆動の刈り込みは index1 を
      // 必ず範囲に残す（過小な下界は刈りが甘くなるだけで、取りこぼしを生まない）。
      final n = arrivalFeasiblePrefixCount(
        walk1Min: const [10, 40, 80],
        minRemainMin: const [20, 20, 20],
        budgetMin: 100,
      );
      expect(n, greaterThan(1));
    });

    test('下界が欠ける index は 0 として扱う（刈らない側へ倒す）', () {
      // 下界の算出が一部で失敗しても、その点は「残り所要0」＝刈らない扱いになり
      // 探索に委ねられる。安全側（取りこぼさない側）への縮退。
      expect(
        arrivalFeasiblePrefixCount(
          walk1Min: const [10, 40, 80],
          minRemainMin: const [60], // index1,2 は欠落
          budgetMin: 100,
        ),
        3,
      );
    });
  });

  // 見積り予算内候補を実測する短リスト（#315/#318）。先行実測と _selectAndEnrich の
  // tier 実測が同一集合・同一順序を測るための単一の並び。
  group('measureShortlist', () {
    final departureAt = DateTime(2026, 7, 15, 9, 0);

    test('予算外を落とし徒歩降順に並べる', () {
      final over = _candidate([_walk(50), _train(30)]); // 計80＞60
      final walk20 = _candidate([_walk(20), _train(10)]); // 計30
      final walk15 = _candidate([_walk(15), _train(10)]); // 計25
      final walk10 = _candidate([_walk(10), _train(10)]); // 計20

      final shortlist = measureShortlist(
        candidates: [walk10, over, walk20, walk15],
        budgetMin: 60,
        departureAt: departureAt,
      );

      expect(shortlist, [walk20, walk15, walk10]);
    });

    test('徒歩同値は実到着昇順で並べる', () {
      final earlier = _candidate([_walk(10), _train(5)]); // 計15
      final later = _candidate([_walk(10), _train(20)]); // 計30

      final shortlist = measureShortlist(
        candidates: [later, earlier],
        budgetMin: 60,
        departureAt: departureAt,
      );

      expect(shortlist, [earlier, later]);
    });
  });

  // 非崩壊ルートの先行実測対象と single-pass 発火有無（#318）。見積り予算内ハイブリッドが
  // 閾値以上並ぶ reject 多発ルートでは短リスト全体を、そうでなければ勝者だけを温める。
  group('prewarmFront', () {
    ({List<RouteCandidate> shortlist, RouteCandidate chosen}) fiveInBudget() {
      final chosen = _candidate([_walk(25), _train(10)]); // 徒歩最大＝見積り勝者
      final b = _candidate([_walk(20), _train(10)]);
      final c = _candidate([_walk(15), _train(10)]);
      final d = _candidate([_walk(10), _train(10)]);
      final e = _candidate([_walk(5), _train(10)]);
      return (shortlist: [chosen, b, c, d, e], chosen: chosen);
    }

    test('予算内ハイブリッドが閾値以上なら短リスト全体を single-pass で温める', () {
      final s = fiveInBudget();
      // 上位3件をハイブリッド扱い（identity 集合）。
      final hybrids = Set<RouteCandidate>.identity()
        ..addAll(s.shortlist.take(3));

      final r = prewarmFront(
        shortlist: s.shortlist,
        chosen: s.chosen,
        hybrids: hybrids,
        singlePassHybridThreshold: 3,
        maxMeasureShortlist: 13,
      );

      expect(r.singlePass, isTrue);
      expect(r.prewarm, s.shortlist);
    });

    test('予算内ハイブリッドが閾値未満なら勝者だけを温める', () {
      final s = fiveInBudget();
      final hybrids = Set<RouteCandidate>.identity()
        ..addAll(s.shortlist.take(2)); // 2件＜閾値3

      final r = prewarmFront(
        shortlist: s.shortlist,
        chosen: s.chosen,
        hybrids: hybrids,
        singlePassHybridThreshold: 3,
        maxMeasureShortlist: 13,
      );

      expect(r.singlePass, isFalse);
      // Option B は勝者のみ。棄却時の次候補は winner-phase の tier 実測に委ねる。
      expect(r.prewarm, [s.chosen]);
    });

    test('allowSinglePass=false なら閾値以上でも勝者のみへ抑制する', () {
      final s = fiveInBudget();
      final hybrids = Set<RouteCandidate>.identity()
        ..addAll(s.shortlist.take(3)); // 閾値は満たす

      final r = prewarmFront(
        shortlist: s.shortlist,
        chosen: s.chosen,
        hybrids: hybrids,
        singlePassHybridThreshold: 3,
        maxMeasureShortlist: 13,
        allowSinglePass: false, // 締切切れ等で広い先行実測を許さない
      );

      expect(r.singlePass, isFalse);
      expect(r.prewarm, [s.chosen]);
    });

    test('single-pass の温め対象は maxMeasureShortlist 件で頭打ち', () {
      final many = [
        for (var i = 0; i < 15; i++) _candidate([_walk(30 - i), _train(10)]),
      ];
      final hybrids = Set<RouteCandidate>.identity()..addAll(many);

      final r = prewarmFront(
        shortlist: many,
        chosen: many.first,
        hybrids: hybrids,
        singlePassHybridThreshold: 3,
        maxMeasureShortlist: 13,
      );

      expect(r.singlePass, isTrue);
      expect(r.prewarm.length, 13);
      expect(r.prewarm, many.sublist(0, 13));
    });
  });
}
