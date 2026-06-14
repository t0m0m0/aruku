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

    test('深夜帯: untimed電車が予算内でも全徒歩を優先する（#121 untimed深夜）', () {
      // 深夜1:51発。untimed電車ルートは待ち0・楽観で予算内に収まるが、3am台の電車は
      // 走っていないため乗れない。全徒歩は予算をわずかに超過する best-effort 状況でも、
      // 確証できない深夜untimed電車より全徒歩を優先しなければならない（スクショ再現）。
      final departureAt = DateTime(2026, 6, 14, 1, 51);
      final untimedNight = _candidate([_walk(86), _train(11), _walk(60)]);
      final fullWalk = _candidate([_walk(185, km: 11.9)]);

      final best = selectBestRoute(
        candidates: [untimedNight, fullWalk],
        budgetMin: 180, // untimed電車157分=予算内 / 全徒歩185分=超過
        departureAt: departureAt,
      );

      expect(best, same(fullWalk));
    });

    test('昼間: untimed電車が予算内なら徒歩最大として選ぶ（#67 維持）', () {
      // 9:00発。日中の untimed電車は対象外で、徒歩最大のハイブリッドを通常どおり選ぶ。
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
}
