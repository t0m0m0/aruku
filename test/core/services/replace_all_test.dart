import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/models/recent_destination.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/favorites_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('FavoritesRepository.replaceAll は一覧を差し替える', () async {
    final prefs = await SharedPreferences.getInstance();
    final repo = FavoritesRepository(prefs);
    await repo.toggle(const FavoritePlace(name: '旧', placeId: 'old'));

    await repo.replaceAll(const [
      FavoritePlace(name: '東京駅', placeId: 'p1'),
      FavoritePlace(name: '渋谷駅', placeId: 'p2'),
    ]);

    final loaded = await repo.load();
    expect(loaded.map((e) => e.name), ['東京駅', '渋谷駅']);
  });

  test('RecentsRepository.replaceAll は maxItems で切り詰める', () async {
    final prefs = await SharedPreferences.getInstance();
    final repo = RecentsRepository(prefs);

    await repo.replaceAll([
      for (var i = 0; i < RecentsRepository.maxItems + 5; i++)
        RecentDestination(name: 'r$i', placeId: 'p$i'),
    ]);

    expect((await repo.load()).length, RecentsRepository.maxItems);
  });

  test('ActivityLogRepository.replaceAll は保持期間外を捨て昇順に並べる', () async {
    final prefs = await SharedPreferences.getInstance();
    final repo = ActivityLogRepository(prefs);
    final now = DateTime(2026, 6, 8);

    await repo.replaceAll([
      DailyActivity(date: DateTime(2026, 6, 7), steps: 200),
      DailyActivity(date: DateTime(2026, 6, 5), steps: 100),
      // 保持期間（400日）より前 → 捨てられる。
      DailyActivity(date: DateTime(2024, 1, 1), steps: 999),
    ], now: now);

    final loaded = await repo.load();
    expect(loaded.map((e) => e.steps), [100, 200]);
  });
}
