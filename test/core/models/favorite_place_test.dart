import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('FavoritePlace', () {
    test('dedupeKey prefers placeId when present', () {
      const place = FavoritePlace(name: '東京駅', placeId: 'abc');
      expect(place.dedupeKey, 'id:abc');
    });

    test('dedupeKey falls back to name when placeId empty', () {
      const place = FavoritePlace(name: '東京駅', placeId: '');
      expect(place.dedupeKey, 'name:東京駅');
    });

    test('dedupeKey falls back to name when placeId null', () {
      const place = FavoritePlace(name: '東京駅');
      expect(place.dedupeKey, 'name:東京駅');
    });

    test('toJson/fromJson round trips all fields', () {
      final savedAt = DateTime.utc(2026, 6, 5, 12, 30);
      final place = FavoritePlace(
        name: '渋谷',
        placeId: 'pid-1',
        latLng: const GeoPoint(35.6, 139.7),
        address: '東京都渋谷区',
        savedAt: savedAt,
      );
      final restored = FavoritePlace.fromJson(place.toJson());
      expect(restored.name, '渋谷');
      expect(restored.placeId, 'pid-1');
      expect(restored.latLng?.lat, 35.6);
      expect(restored.latLng?.lng, 139.7);
      expect(restored.address, '東京都渋谷区');
      expect(restored.savedAt, savedAt);
    });

    test('fromJson tolerates missing optional fields', () {
      final place = FavoritePlace.fromJson(const {'name': '新宿'});
      expect(place.name, '新宿');
      expect(place.placeId, isNull);
      expect(place.latLng, isNull);
      expect(place.savedAt, isNull);
    });
  });
}
