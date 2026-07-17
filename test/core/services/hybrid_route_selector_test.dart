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

  group('paretoAlternatives', () {
    test('支配される候補（到着も徒歩も劣る）は除去される', () {
      final chosen = _candidate([_walk(20), _train(10)]); // 到着30 徒歩20
      final tradeoff = _candidate([_walk(15), _train(5)]); // 到着20 徒歩15
      final dominated = _candidate([_walk(10), _train(15)]); // 到着25 徒歩10

      final alts = paretoAlternatives(
        candidates: [chosen, tradeoff, dominated],
        chosen: chosen,
      );

      // tradeoff は dominated を支配（早着かつ徒歩多い）ので dominated は落ちる。
      expect(alts, [same(tradeoff)]);
    });

    test('非劣解は保持し、勝者は結果に含めない（到着昇順）', () {
      final chosen = _candidate([_walk(30)]); // 到着30 徒歩30（徒歩最大）
      final more = _candidate([_walk(20), _train(5)]); // 到着25 徒歩20
      final less = _candidate([_walk(10), _train(5)]); // 到着15 徒歩10

      final alts = paretoAlternatives(
        candidates: [chosen, more, less],
        chosen: chosen,
      );

      // more と less は互いに非劣解（徒歩↔到着のトレードオフ）。到着昇順で less→more。
      expect(alts, [same(less), same(more)]);
      expect(alts, isNot(contains(same(chosen))));
    });

    test('勝者と到着・徒歩が完全同値の候補は含めない（差分が見えない）', () {
      final chosen = _candidate([_walk(20), _train(10)]); // 到着30 徒歩20
      final twin = _candidate([_walk(20), _train(10)]); // 別オブジェクトだが同値
      final tradeoff = _candidate([_walk(10), _train(5)]); // 到着15 徒歩10

      final alts = paretoAlternatives(
        candidates: [chosen, twin, tradeoff],
        chosen: chosen,
      );

      expect(alts, isNot(contains(same(twin))));
      expect(alts, [same(tradeoff)]);
    });

    test('返却は最大 maxCount 件（到着の早い順）', () {
      final chosen = _candidate([_walk(30)]); // 到着30 徒歩30
      final alt1 = _candidate([_walk(5), _train(5)]); // 到着10 徒歩5
      final alt2 = _candidate([_walk(10), _train(10)]); // 到着20 徒歩10
      final alt3 = _candidate([_walk(15), _train(10)]); // 到着25 徒歩15

      final alts = paretoAlternatives(
        candidates: [chosen, alt3, alt2, alt1],
        chosen: chosen,
        maxCount: 2,
      );

      expect(alts, [same(alt1), same(alt2)]);
    });

    test('入力順に依存せず同じ結果（到着昇順で決定的）', () {
      final chosen = _candidate([_walk(30)]);
      final more = _candidate([_walk(20), _train(5)]); // 到着25 徒歩20
      final less = _candidate([_walk(10), _train(5)]); // 到着15 徒歩10

      final forward = paretoAlternatives(
        candidates: [chosen, more, less],
        chosen: chosen,
      );
      final reversed = paretoAlternatives(
        candidates: [less, more, chosen],
        chosen: chosen,
      );

      expect(
        forward.map((c) => c.totalMin).toList(),
        reversed.map((c) => c.totalMin).toList(),
      );
      expect(forward, [same(less), same(more)]);
      expect(reversed, [same(less), same(more)]);
    });

    ({RouteCandidate chosen, RouteCandidate longWait, RouteCandidate shortWait})
    waitSensitiveCandidates() {
      // longWait: 待ち抜き合計25分だが待ち時間で実到着45分・徒歩10。
      final longWait = _candidate([
        _walk(10),
        _timedTrain(DateTime(2026, 7, 15, 9, 30), DateTime(2026, 7, 15, 9, 45)),
      ]);
      // shortWait: 待ち抜き合計30分・実到着32分・徒歩20。
      final shortWait = _candidate([
        _walk(20),
        _timedTrain(DateTime(2026, 7, 15, 9, 22), DateTime(2026, 7, 15, 9, 32)),
      ]);
      final chosen = _candidate([
        _walk(40),
        _timedTrain(DateTime(2026, 7, 15, 9, 50), DateTime(2026, 7, 15, 10, 0)),
      ]);
      return (chosen: chosen, longWait: longWait, shortWait: shortWait);
    }

    test('departureAt ありでは待ち時間込みの実到着で支配を判定する', () {
      final c = waitSensitiveCandidates();

      final alts = paretoAlternatives(
        candidates: [c.chosen, c.longWait, c.shortWait],
        chosen: c.chosen,
        departureAt: DateTime(2026, 7, 15, 9),
      );

      // 実到着 shortWait(32,徒歩20) が longWait(45,徒歩10) を支配（早着かつ徒歩多い）。
      expect(alts, [same(c.shortWait)]);
    });

    test('departureAt 省略時は totalMin で判定するため両者が非劣解として残る', () {
      final c = waitSensitiveCandidates();

      final alts = paretoAlternatives(
        candidates: [c.chosen, c.longWait, c.shortWait],
        chosen: c.chosen,
      );

      // 待ち抜き合計は longWait(25,徒歩10) と shortWait(30,徒歩20) でトレードオフ。
      expect(alts, [same(c.longWait), same(c.shortWait)]);
    });
  });

  group('forwardCandidates', () {
    test('逆戻り候補を除き、全滅時と origin/goal 未指定時はそのまま返す', () {
      const origin = GeoPoint(35.50, 139.50);
      const goal = GeoPoint(35.70, 139.50); // 出発地の北
      // 出発地より南（目的地と逆方向）の駅を経由する逆戻り候補。
      final backtrack = _candidate([
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
      final straight = _candidate([_walk(10), _train(8)]);

      expect(forwardCandidates([backtrack, straight], origin, goal), [
        same(straight),
      ]);
      // 全候補が逆戻りなら除外せずそのまま（selectBestRoute の縮退と同じ）。
      expect(forwardCandidates([backtrack], origin, goal), [same(backtrack)]);
      // origin/goal 未指定はフィルタなし。
      expect(forwardCandidates([backtrack, straight], null, null), [
        same(backtrack),
        same(straight),
      ]);
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

    test('fanout=1 は直列二分探索と同一の挙動（中点1点ずつ）', () async {
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
      // 直列版と同じ二分探索の軌道: mid=4→6→7→(区間枯れ) の順。
      expect(evaluated, [4, 6, 7]);
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
}
