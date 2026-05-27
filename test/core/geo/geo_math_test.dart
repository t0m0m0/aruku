import 'package:aruku/core/geo/geo_math.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('metersBetween', () {
    test('緯度1度はおよそ111kmになる', () {
      final m = metersBetween(const GeoPoint(0, 0), const GeoPoint(1, 0));
      expect(m, closeTo(111195, 500));
    });

    test('同一点は0', () {
      expect(
        metersBetween(const GeoPoint(35.6, 139.7), const GeoPoint(35.6, 139.7)),
        0,
      );
    });
  });

  group('bearingDegrees', () {
    test('北は0度', () {
      expect(
        bearingDegrees(const GeoPoint(0, 0), const GeoPoint(1, 0)),
        closeTo(0, 0.5),
      );
    });

    test('東は90度', () {
      expect(
        bearingDegrees(const GeoPoint(0, 0), const GeoPoint(0, 1)),
        closeTo(90, 0.5),
      );
    });

    test('南は180度', () {
      expect(
        bearingDegrees(const GeoPoint(0, 0), const GeoPoint(-1, 0)),
        closeTo(180, 0.5),
      );
    });

    test('西は270度', () {
      expect(
        bearingDegrees(const GeoPoint(0, 0), const GeoPoint(0, -1)),
        closeTo(270, 0.5),
      );
    });
  });

  group('snapToPolyline', () {
    test('線上の点は累積距離が半分・オフセットほぼ0', () {
      const path = [GeoPoint(0, 0), GeoPoint(0, 1)];
      final total = metersBetween(path[0], path[1]);
      final snap = snapToPolyline(path, const GeoPoint(0, 0.5));
      expect(snap.offsetMeters, closeTo(0, 5));
      expect(snap.distanceAlongMeters, closeTo(total / 2, total * 0.01));
      expect(snap.segmentIndex, 0);
    });

    test('線から外れた点はオフセットが正・累積距離は投影位置', () {
      const path = [GeoPoint(0, 0), GeoPoint(0, 1)];
      final total = metersBetween(path[0], path[1]);
      final snap = snapToPolyline(path, const GeoPoint(0.001, 0.5));
      expect(snap.offsetMeters, greaterThan(50));
      expect(snap.distanceAlongMeters, closeTo(total / 2, total * 0.02));
    });

    test('始点より手前の点は累積距離0にクランプ', () {
      const path = [GeoPoint(0, 0), GeoPoint(0, 1)];
      final snap = snapToPolyline(path, const GeoPoint(0, -0.5));
      expect(snap.distanceAlongMeters, closeTo(0, 5));
      expect(snap.segmentIndex, 0);
    });

    test('L字経路では最近接の辺へスナップする', () {
      const path = [GeoPoint(0, 0), GeoPoint(0, 1), GeoPoint(1, 1)];
      // 2本目の辺（東経1で北上）の途中(0.5,1)付近。
      final snap = snapToPolyline(path, const GeoPoint(0.5, 1.001));
      expect(snap.segmentIndex, 1);
      final firstEdge = metersBetween(path[0], path[1]);
      expect(snap.distanceAlongMeters, greaterThan(firstEdge));
    });
  });
}
