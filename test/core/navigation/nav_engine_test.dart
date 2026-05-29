import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/navigation/nav_engine.dart';
import 'package:flutter_test/flutter_test.dart';

RoutePlan _route({
  required List<RouteSegment> segments,
  int kcal = 100,
  int totalMin = 30,
  double totalKm = 2.2,
  double walkKm = 2.2,
}) => RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: totalKm,
  totalMin: totalMin,
  budgetMin: 60,
  kcal: kcal,
  walkKm: walkKm,
  walkRatio: walkKm / totalKm,
  segments: segments,
  timelineNodes: const [],
);

void main() {
  group('NavManeuver.label', () {
    test('日本語ラベルを返す', () {
      expect(NavManeuver.straight.label, '直進');
      expect(NavManeuver.left.label, '左折');
      expect(NavManeuver.right.label, '右折');
      expect(NavManeuver.slightLeft.label, '斜め左');
      expect(NavManeuver.slightRight.label, '斜め右');
      expect(NavManeuver.arrive.label, 'まもなく到着');
    });
  });

  group('computeGuidance', () {
    // L字: 東へ進み→左折して北上。頂点で 90 度左折。
    const lShape = [GeoPoint(0, 0), GeoPoint(0, 0.01), GeoPoint(0.01, 0.01)];
    final lRoute = _route(
      segments: const [
        RouteSegment(
          type: SegmentType.walk,
          fromName: 'A',
          toName: 'B',
          minutes: 30,
          km: 2.2,
          kcal: 100,
          polyline: lShape,
        ),
      ],
    );

    test('曲がり手前では次の曲がりが左折・その次は到着', () {
      final g = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0, 0.001),
      );
      expect(g.currentManeuver, NavManeuver.left);
      expect(g.nextManeuver, NavManeuver.arrive);
      expect(g.distanceToNextTurnM, greaterThan(0));
    });

    test('曲がりを過ぎると到着案内になる', () {
      final g = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0.005, 0.01),
      );
      expect(g.currentManeuver, NavManeuver.arrive);
      expect(g.nextManeuver, isNull);
    });

    test('前進すると進捗↑・残距離↓・消費kcal↑', () {
      final near = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0, 0.001),
      );
      final far = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0.009, 0.01),
      );
      expect(far.progress, greaterThan(near.progress));
      expect(far.remainingKm, lessThan(near.remainingKm));
      expect(far.consumedKcal, greaterThanOrEqualTo(near.consumedKcal));
      expect(far.progress, inInclusiveRange(0.0, 1.0));
    });

    test('ETA は進捗に応じて減る', () {
      final near = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0, 0.001),
      );
      final far = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0.009, 0.01),
      );
      expect(far.etaMinutesRemaining, lessThan(near.etaMinutesRemaining));
      expect(near.etaMinutesRemaining, lessThanOrEqualTo(30));
    });

    test('直線経路は開始時点から到着案内', () {
      final straight = _route(
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'B',
            minutes: 20,
            km: 1.1,
            kcal: 60,
            polyline: [GeoPoint(0, 0), GeoPoint(0, 0.01)],
          ),
        ],
        totalKm: 1.1,
        walkKm: 1.1,
      );
      final g = computeGuidance(
        route: straight,
        current: const GeoPoint(0, 0.0),
      );
      expect(g.currentManeuver, NavManeuver.arrive);
    });

    test('消費kcalは徒歩距離比のみで按分する（電車区間は加算しない）', () {
      // 徒歩(東へ)→電車(北へ)→徒歩(東へ)。kcal は徒歩2区間のみ。
      final mixed = _route(
        kcal: 200,
        totalKm: 3.3,
        walkKm: 2.2,
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'S1',
            minutes: 15,
            km: 1.1,
            kcal: 100,
            polyline: [GeoPoint(0, 0), GeoPoint(0, 0.01)],
          ),
          RouteSegment(
            type: SegmentType.train,
            fromName: 'S1',
            toName: 'S2',
            minutes: 5,
            km: 1.1,
            polyline: [GeoPoint(0, 0.01), GeoPoint(0.01, 0.01)],
          ),
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'S2',
            toName: 'B',
            minutes: 15,
            km: 1.1,
            kcal: 100,
            polyline: [GeoPoint(0.01, 0.01), GeoPoint(0.01, 0.02)],
          ),
        ],
      );
      // 1本目の徒歩を歩き切った地点（電車乗車直前）。徒歩進捗はちょうど半分。
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0, 0.0099),
      );
      expect(g.consumedKcal, closeTo(100, 10));
    });

    test('ポリラインが空でも破綻しない', () {
      final empty = _route(
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'B',
            minutes: 20,
            km: 1.0,
            kcal: 50,
          ),
        ],
      );
      final g = computeGuidance(route: empty, current: const GeoPoint(0, 0));
      expect(g.progress, 0);
      expect(g.currentManeuver, NavManeuver.arrive);
      expect(g.etaMinutesRemaining, 30);
    });

    test('電車区間の線形カーブは曲がり案内に含めない（徒歩区間のみ対象）', () {
      // 徒歩(東)→電車(北→東で右カーブ)→徒歩(北)。電車のカーブを誤検出しない。
      final mixed = _route(
        totalKm: 3.0,
        walkKm: 2.0,
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'S1',
            minutes: 10,
            km: 1.0,
            kcal: 50,
            polyline: [GeoPoint(0, 0), GeoPoint(0, 0.01)],
          ),
          RouteSegment(
            type: SegmentType.train,
            fromName: 'S1',
            toName: 'S2',
            minutes: 5,
            km: 1.0,
            polyline: [
              GeoPoint(0, 0.01),
              GeoPoint(0.01, 0.01),
              GeoPoint(0.01, 0.02),
            ],
          ),
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'S2',
            toName: 'B',
            minutes: 10,
            km: 1.0,
            kcal: 50,
            polyline: [GeoPoint(0.01, 0.02), GeoPoint(0.02, 0.02)],
          ),
        ],
      );
      // 第1徒歩区間を歩行中。電車の 90 度カーブを「右折」と案内しない。
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0, 0.005),
      );
      expect(g.currentManeuver, NavManeuver.arrive);
      expect(g.nextManeuver, isNull);
    });

    test('電車区間の後の徒歩区間の曲がりは案内する', () {
      // 徒歩(東)→電車(北)→徒歩(東→北で左折)。徒歩の曲がりは残す。
      final mixed = _route(
        totalKm: 3.0,
        walkKm: 2.0,
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'S1',
            minutes: 10,
            km: 1.0,
            kcal: 50,
            polyline: [GeoPoint(0, 0), GeoPoint(0, 0.01)],
          ),
          RouteSegment(
            type: SegmentType.train,
            fromName: 'S1',
            toName: 'S2',
            minutes: 5,
            km: 1.0,
            polyline: [GeoPoint(0, 0.01), GeoPoint(0.01, 0.01)],
          ),
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'S2',
            toName: 'B',
            minutes: 10,
            km: 1.0,
            kcal: 50,
            polyline: [
              GeoPoint(0.01, 0.01),
              GeoPoint(0.01, 0.02),
              GeoPoint(0.02, 0.02),
            ],
          ),
        ],
      );
      // 第2徒歩区間の入口。区間内の左折を案内する。
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0.01, 0.011),
      );
      expect(g.currentManeuver, NavManeuver.left);
    });
  });

  group('offRouteMeters', () {
    final straight = _route(
      segments: const [
        RouteSegment(
          type: SegmentType.walk,
          fromName: 'A',
          toName: 'B',
          minutes: 20,
          km: 1.1,
          kcal: 60,
          polyline: [GeoPoint(0, 0), GeoPoint(0, 0.01)],
        ),
      ],
      totalKm: 1.1,
      walkKm: 1.1,
    );

    test('経路上の点では逸脱距離はほぼ 0', () {
      final g = computeGuidance(
        route: straight,
        current: const GeoPoint(0, 0.005),
      );
      expect(g.offRouteMeters, lessThan(1.0));
    });

    test('経路から大きく外れると逸脱距離が増える', () {
      final g = computeGuidance(
        route: straight,
        current: const GeoPoint(0.005, 0.005),
      );
      // 緯度 0.005 度 ≈ 約 556m の横ずれ。
      expect(g.offRouteMeters, greaterThan(100.0));
    });
  });
}
