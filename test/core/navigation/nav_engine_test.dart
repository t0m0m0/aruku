import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/navigation/nav_engine.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/widgets.dart';
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
  group('maneuverLabel', () {
    late AppLocalizations l10n;

    setUpAll(() async {
      l10n = await AppLocalizations.delegate.load(const Locale('ja'));
    });

    test('日本語ラベルを返す', () {
      expect(maneuverLabel(l10n, NavManeuver.straight), '直進');
      expect(maneuverLabel(l10n, NavManeuver.left), '左折');
      expect(maneuverLabel(l10n, NavManeuver.right), '右折');
      expect(maneuverLabel(l10n, NavManeuver.slightLeft), '斜め左');
      expect(maneuverLabel(l10n, NavManeuver.slightRight), '斜め右');
      expect(maneuverLabel(l10n, NavManeuver.arrive), 'まもなく到着');
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

    test('自己交差する経路ではpreviousDistanceAlongMetersで進捗のジャンプを防ぐ', () {
      // 往路(緯度0)を東へ進み、並走する復路(緯度0.0006)で西へ戻る折り返し経路。
      final loop = _route(
        segments: [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'B',
            minutes: 30,
            km: 2.2,
            kcal: 100,
            polyline: [
              for (var i = 0; i <= 10; i++) GeoPoint(0, i * 0.1),
              for (var i = 9; i >= 0; i--) GeoPoint(0.0006, i * 0.1),
            ],
          ),
        ],
      );

      final without = computeGuidance(
        route: loop,
        current: const GeoPoint(0.0004, 0.5),
      );
      // 直前位置を往路上(緯度0, 経度0.5)相当として渡すと、並走する復路側へ
      // 進捗が飛ばず往路側にとどまる。
      final previous = computeGuidance(
        route: loop,
        current: const GeoPoint(0, 0.5),
      ).traveledKm;
      final withPrevious = computeGuidance(
        route: loop,
        current: const GeoPoint(0.0004, 0.5),
        previousDistanceAlongMeters: previous * 1000,
      );

      expect(withPrevious.traveledKm, isNot(closeTo(without.traveledKm, 1)));
      expect(withPrevious.traveledKm, closeTo(previous, 1));
    });

    test('totalKmはポリライン実測合計でtraveledKm+remainingKmと一致する', () {
      // route.totalKm(2.2)はAPI由来の概算値で、Lシェイプの実測合計とは
      // 一致しない。totalKmは常にtraveledKm+remainingKmと一致すべき。
      final g = computeGuidance(
        route: lRoute,
        current: const GeoPoint(0, 0.005),
      );
      expect(g.totalKm, closeTo(g.traveledKm + g.remainingKm, 0.0001));
      expect(g.totalKm, isNot(closeTo(2.2, 0.0001)));
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

    test('ETAは距離按分ではなく区間ごとの所要時間を積み上げて算出する', () {
      // 徒歩1km/10分 → 電車10km/5分。電車は徒歩よりはるかに速い。
      final hybrid = _route(
        totalMin: 15,
        totalKm: 11.0,
        walkKm: 1.0,
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'S1',
            minutes: 10,
            km: 1.0,
            kcal: 50,
            polyline: [GeoPoint(0, 0), GeoPoint(0, 0.009)],
          ),
          RouteSegment(
            type: SegmentType.train,
            fromName: 'S1',
            toName: 'S2',
            minutes: 5,
            km: 10.0,
            polyline: [GeoPoint(0, 0.009), GeoPoint(0, 0.099)],
          ),
        ],
      );
      // 徒歩区間を歩き切り、電車に乗った直後の地点。
      final g = computeGuidance(
        route: hybrid,
        current: const GeoPoint(0, 0.0095),
      );
      // 誤: 距離按分だと s≈1000m/11000m の進捗で ETA≈13.6分になってしまう。
      // 正: 徒歩10分は消化済みなので残りは電車の5分程度のはず。
      expect(g.etaMinutesRemaining, lessThanOrEqualTo(6));
    });

    test('区間所要時間の合計がtotalMinと一致しない（乗換待ち等）場合も到着時にETAが0になる', () {
      // 徒歩1km/10分 + 電車9km/5分の距離概算合計は15分だが、乗換待ちを
      // totalMinに含めているため totalMin=20（route_plan_builderの_advance仕様）。
      final withWait = _route(
        totalMin: 20,
        totalKm: 10.0,
        walkKm: 1.0,
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'S1',
            minutes: 10,
            km: 1.0,
            kcal: 50,
            polyline: [GeoPoint(0, 0), GeoPoint(0, 0.009)],
          ),
          RouteSegment(
            type: SegmentType.train,
            fromName: 'S1',
            toName: 'S2',
            minutes: 5,
            km: 9.0,
            polyline: [GeoPoint(0, 0.009), GeoPoint(0, 0.09)],
          ),
        ],
      );
      final g = computeGuidance(
        route: withWait,
        current: const GeoPoint(0, 0.09),
      );
      expect(g.etaMinutesRemaining, 0);
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
      // 第1徒歩区間を歩行中。電車の 90 度カーブを「右折」と案内しない
      // （次の操作は乗車イベントになる）。
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0, 0.005),
      );
      expect(g.currentManeuver, NavManeuver.board);
      expect(g.nextManeuver, NavManeuver.alight);
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

  group('isOnTrainSegment', () {
    // 徒歩(東)→電車(北)→徒歩(東)。
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
          polyline: [GeoPoint(0.01, 0.01), GeoPoint(0.01, 0.02)],
        ),
      ],
    );

    test('最寄り区間が電車のとき true になる', () {
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0.005, 0.01),
      );
      expect(g.isOnTrainSegment, isTrue);
    });

    test('最寄り区間が徒歩のとき false になる', () {
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0, 0.005),
      );
      expect(g.isOnTrainSegment, isFalse);
    });
  });

  group('乗車/下車イベント', () {
    // 徒歩(東, A→S1)→電車(北, S1で乗車・S2で下車)→徒歩(東, S2→B)。
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
          line: '山手線',
          polyline: [GeoPoint(0, 0.01), GeoPoint(0.01, 0.01)],
        ),
        RouteSegment(
          type: SegmentType.walk,
          fromName: 'S2',
          toName: 'B',
          minutes: 10,
          km: 1.0,
          kcal: 50,
          polyline: [GeoPoint(0.01, 0.01), GeoPoint(0.01, 0.02)],
        ),
      ],
    );

    test('電車区間手前では次の操作が乗車になり路線名・乗車駅名を持つ', () {
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0, 0.005),
      );
      expect(g.currentManeuver, NavManeuver.board);
      expect(g.currentLine, '山手線');
      expect(g.currentStationName, 'S1');
    });

    test('電車乗車中は次の操作が下車になり路線名・降車駅名を持つ', () {
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0.005, 0.01),
      );
      expect(g.currentManeuver, NavManeuver.alight);
      expect(g.currentLine, '山手線');
      expect(g.currentStationName, 'S2');
    });

    test('下車後の徒歩区間では乗車/下車イベントは既出扱いになり案内に出ない', () {
      final g = computeGuidance(
        route: mixed,
        current: const GeoPoint(0.01, 0.015),
      );
      expect(g.currentManeuver, NavManeuver.arrive);
      expect(g.currentStationName, isNull);
    });
  });
}
