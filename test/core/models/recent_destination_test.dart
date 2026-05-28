import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/recent_destination.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('RecentDestination', () {
    final usedAt = DateTime.utc(2026, 5, 28, 10, 0);
    const latLng = GeoPoint(35.681236, 139.767125);

    test('JSON ラウンドトリップで全フィールドが保持される', () {
      const original = RecentDestination(
        name: '東京駅',
        placeId: 'place_abc',
        latLng: latLng,
        address: '東京都千代田区',
      );
      final json = original.copyWith(usedAt: usedAt).toJson();
      final decoded = RecentDestination.fromJson(json);
      expect(decoded.name, '東京駅');
      expect(decoded.placeId, 'place_abc');
      expect(decoded.latLng, latLng);
      expect(decoded.address, '東京都千代田区');
      expect(decoded.usedAt, usedAt);
    });

    test('optional フィールドが null でも JSON で復元できる', () {
      final original = RecentDestination(name: '渋谷', usedAt: usedAt);
      final decoded = RecentDestination.fromJson(original.toJson());
      expect(decoded.name, '渋谷');
      expect(decoded.placeId, isNull);
      expect(decoded.latLng, isNull);
      expect(decoded.address, isNull);
      expect(decoded.usedAt, usedAt);
    });

    test('dedupeKey は placeId 優先、無ければ name', () {
      const a = RecentDestination(name: '東京駅', placeId: 'p1');
      const b = RecentDestination(name: '東京駅');
      expect(a.dedupeKey, 'id:p1');
      expect(b.dedupeKey, 'name:東京駅');
    });
  });
}
