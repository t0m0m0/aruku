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
