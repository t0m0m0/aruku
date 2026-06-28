import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/models/recent_place.dart';
import 'package:aruku/core/models/sync_data.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  SyncData sample({required DateTime updatedAt, AppSettings? settings}) =>
      SyncData(
        updatedAt: updatedAt,
        settings: settings ?? AppSettings.defaults,
        favorites: const [FavoritePlace(name: '東京駅', placeId: 'p1')],
        recents: const [RecentPlace(name: '渋谷駅', placeId: 'p2')],
        recentOrigins: const [RecentPlace(name: '自宅', placeId: 'o1')],
        activity: [DailyActivity(date: DateTime(2026, 6, 1), steps: 1200)],
      );

  test('toJson / fromJson でラウンドトリップする', () {
    final data = sample(
      updatedAt: DateTime.utc(2026, 6, 8, 12),
      settings: const AppSettings(notificationsEnabled: false),
    );
    final restored = SyncData.fromJson(data.toJson());

    expect(restored.updatedAt, data.updatedAt);
    expect(restored.settings.notificationsEnabled, isFalse);
    expect(restored.favorites.single.name, '東京駅');
    expect(restored.recents.single.name, '渋谷駅');
    expect(restored.recentOrigins.single.name, '自宅');
    expect(restored.activity.single.steps, 1200);
  });

  test('壊れた/欠損フィールドは既定へフォールバックする', () {
    final restored = SyncData.fromJson(const {});
    expect(restored.settings, AppSettings.defaults);
    expect(restored.favorites, isEmpty);
    expect(restored.recents, isEmpty);
    expect(restored.recentOrigins, isEmpty);
    expect(restored.activity, isEmpty);
  });

  group('mergeLww（last-write-wins）', () {
    test('updatedAt が新しい側を採用する', () {
      final older = sample(updatedAt: DateTime.utc(2026, 6, 1));
      final newer = sample(
        updatedAt: DateTime.utc(2026, 6, 8),
        settings: const AppSettings(notificationsEnabled: false),
      );

      expect(SyncData.mergeLww(local: older, remote: newer), same(newer));
      expect(SyncData.mergeLww(local: newer, remote: older), same(newer));
    });

    test('同時刻ならローカルを優先する（不要な上書きを避ける）', () {
      final at = DateTime.utc(2026, 6, 8);
      final local = sample(updatedAt: at);
      final remote = sample(updatedAt: at);
      expect(SyncData.mergeLww(local: local, remote: remote), same(local));
    });
  });
}
