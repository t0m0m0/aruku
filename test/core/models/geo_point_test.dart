import 'package:aruku/core/models/geo_point.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('GeoPoint.heading', () {
    test('headingを保持できる', () {
      const p = GeoPoint(35.68, 139.76, heading: 45.0);

      expect(p.heading, 45.0);
    });

    test('heading未指定時はnull', () {
      const p = GeoPoint(35.68, 139.76);

      expect(p.heading, isNull);
    });

    test('headingが異なっても緯度経度が同じなら等価（位置比較ロジックへの影響を避ける）', () {
      const a = GeoPoint(35.68, 139.76, heading: 10.0);
      const b = GeoPoint(35.68, 139.76, heading: 200.0);

      expect(a, b);
      expect(a.hashCode, b.hashCode);
    });
  });
}
