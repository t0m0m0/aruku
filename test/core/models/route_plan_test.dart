import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/shared/extensions/route_map_overlays.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../support/route_plan_fixtures.dart';

void main() {
  group('RouteSegment.polyline', () {
    test('defaults to an empty list when omitted', () {
      const seg = RouteSegment(
        type: SegmentType.walk,
        fromName: 'A',
        toName: 'B',
        minutes: 10,
      );
      expect(seg.polyline, isEmpty);
    });

    test('stores the provided coordinates', () {
      const seg = RouteSegment(
        type: SegmentType.walk,
        fromName: 'A',
        toName: 'B',
        minutes: 10,
        polyline: [GeoPoint(35.0, 139.0), GeoPoint(35.1, 139.1)],
      );
      expect(seg.polyline, hasLength(2));
      expect(seg.polyline.first, const GeoPoint(35.0, 139.0));
    });
  });

  group('sampleRoutePlan', () {
    test('every segment carries a non-empty polyline', () {
      for (final seg in sampleRoutePlan.segments) {
        expect(
          seg.polyline,
          isNotEmpty,
          reason: '${seg.fromName} → ${seg.toName} の座標が空',
        );
      }
    });

    test('consecutive segments connect end-to-start', () {
      final segs = sampleRoutePlan.segments;
      for (var i = 0; i < segs.length - 1; i++) {
        expect(
          segs[i].polyline.last,
          segs[i + 1].polyline.first,
          reason: 'セグメント $i と ${i + 1} が連結していない',
        );
      }
    });
  });

  group('RoutePlan.alternatives', () {
    test('省略時は空リスト（既存フィクスチャの後方互換）', () {
      expect(sampleRoutePlan.alternatives, isEmpty);
    });

    test('渡した代替案を保持する', () {
      const plan = RoutePlan(
        from: 'A',
        to: 'B',
        totalKm: 1,
        totalMin: 1,
        budgetMin: 1,
        kcal: 1,
        walkKm: 1,
        walkRatio: 1,
        segments: [],
        timelineNodes: [],
        alternatives: [sampleRoutePlan],
      );
      expect(plan.alternatives, hasLength(1));
      expect(plan.alternatives.first.from, sampleRoutePlan.from);
    });
  });

  group('RoutePlan.transferCount', () {
    RoutePlan planWith(List<RouteSegment> segments) => RoutePlan(
      from: 'A',
      to: 'B',
      totalKm: 1,
      totalMin: 1,
      budgetMin: 1,
      kcal: 1,
      walkKm: 1,
      walkRatio: 1,
      segments: segments,
      timelineNodes: const [],
    );

    test('walk 以外の区間数−1（下限0）で導出する', () {
      const walk = RouteSegment(
        type: SegmentType.walk,
        fromName: 'A',
        toName: 'B',
        minutes: 5,
      );
      const train = RouteSegment(
        type: SegmentType.train,
        fromName: 'B',
        toName: 'C',
        minutes: 10,
      );
      const bus = RouteSegment(
        type: SegmentType.bus,
        fromName: 'C',
        toName: 'D',
        minutes: 10,
      );

      expect(planWith(const [walk]).transferCount, 0);
      expect(planWith(const [walk, train, walk]).transferCount, 0);
      expect(planWith(const [walk, train, walk, bus]).transferCount, 1);
      expect(planWith(const []).transferCount, 0);
    });
  });

  group('RouteMapOverlays.toPolylines', () {
    test('builds one polyline per segment', () {
      expect(
        sampleRoutePlan.toPolylines(),
        hasLength(sampleRoutePlan.segments.length),
      );
    });

    test('walk segments are dashed, train segments are solid', () {
      final byId = {
        for (final p in sampleRoutePlan.toPolylines()) p.polylineId.value: p,
      };
      // sampleRoutePlan: seg0=walk, seg1=train, seg2=walk
      expect(byId['seg-0']!.patterns, isNotEmpty);
      expect(byId['seg-1']!.patterns, isEmpty);
      expect(byId['seg-2']!.patterns, isNotEmpty);
    });

    test('walk uses moss color, train uses train color', () {
      final byId = {
        for (final p in sampleRoutePlan.toPolylines()) p.polylineId.value: p,
      };
      expect(byId['seg-0']!.color, const Color(0xFF4F9527));
      expect(byId['seg-1']!.color, const Color(0xFF3E6792));
    });

    test('skips segments without coordinates', () {
      const plan = RoutePlan(
        from: 'A',
        to: 'B',
        totalKm: 1,
        totalMin: 1,
        budgetMin: 1,
        kcal: 1,
        walkKm: 1,
        walkRatio: 1,
        segments: [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'B',
            minutes: 1,
          ),
        ],
        timelineNodes: [],
      );
      expect(plan.toPolylines(), isEmpty);
    });
  });

  group('RouteMapOverlays.toMarkers', () {
    test('places start and end markers at route extremities', () {
      final markers = {
        for (final m in sampleRoutePlan.toMarkers()) m.markerId.value: m,
      };
      expect(markers.keys, containsAll(<String>['start', 'end']));
      final startGeo = sampleRoutePlan.segments.first.polyline.first;
      final endGeo = sampleRoutePlan.segments.last.polyline.last;
      expect(markers['start']!.position, LatLng(startGeo.lat, startGeo.lng));
      expect(markers['end']!.position, LatLng(endGeo.lat, endGeo.lng));
    });
  });

  group('RouteMapOverlays.toBounds', () {
    test('encloses every coordinate', () {
      final bounds = sampleRoutePlan.toBounds()!;
      for (final seg in sampleRoutePlan.segments) {
        for (final p in seg.polyline) {
          expect(
            p.lat,
            inInclusiveRange(
              bounds.southwest.latitude,
              bounds.northeast.latitude,
            ),
          );
          expect(
            p.lng,
            inInclusiveRange(
              bounds.southwest.longitude,
              bounds.northeast.longitude,
            ),
          );
        }
      }
    });

    test('returns null when there are no coordinates', () {
      const plan = RoutePlan(
        from: 'A',
        to: 'B',
        totalKm: 1,
        totalMin: 1,
        budgetMin: 1,
        kcal: 1,
        walkKm: 1,
        walkRatio: 1,
        segments: [],
        timelineNodes: [],
      );
      expect(plan.toBounds(), isNull);
    });
  });
}
