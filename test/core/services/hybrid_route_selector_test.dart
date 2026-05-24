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
