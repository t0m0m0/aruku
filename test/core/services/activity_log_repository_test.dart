import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<ActivityLogRepository> makeRepo() async {
    final prefs = await SharedPreferences.getInstance();
    return ActivityLogRepository(prefs);
  }

  test('保存ゼロ件なら load は空リスト', () async {
    final repo = await makeRepo();
    expect(await repo.load(), isEmpty);
  });

  test('upsert したものが load で取り出せる', () async {
    final repo = await makeRepo();
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 3), steps: 1000));
    final list = await repo.load();
    expect(list, [DailyActivity(date: DateTime(2026, 6, 3), steps: 1000)]);
  });

  test('同じ日付の upsert は上書きされる', () async {
    final repo = await makeRepo();
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 3), steps: 1000));
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 3), steps: 2500));
    final list = await repo.load();
    expect(list.length, 1);
    expect(list.single.steps, 2500);
  });

  test('複数日は日付昇順で保持される', () async {
    final repo = await makeRepo();
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 3), steps: 300));
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 1), steps: 100));
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 2), steps: 200));
    final list = await repo.load();
    expect(list.map((e) => e.steps).toList(), [100, 200, 300]);
  });

  test('保持期間を超えた古い履歴は刈り取られる', () async {
    final repo = await makeRepo();
    final today = DateTime(2026, 6, 3);
    final old = today.subtract(
      Duration(days: ActivityLogRepository.retentionDays + 5),
    );
    await repo.upsert(DailyActivity(date: old, steps: 100), now: today);
    await repo.upsert(DailyActivity(date: today, steps: 200), now: today);
    final list = await repo.load();
    expect(list.length, 1);
    expect(list.single.steps, 200);
  });

  test('再インスタンス化しても永続化が保たれる', () async {
    final repo = await makeRepo();
    await repo.upsert(DailyActivity(date: DateTime(2026, 6, 3), steps: 1000));
    final repo2 = await makeRepo();
    expect((await repo2.load()).single.steps, 1000);
  });

  test('破損データなら空リストにフォールバック', () async {
    SharedPreferences.setMockInitialValues({
      ActivityLogRepository.storageKey: 'not-json',
    });
    final repo = await makeRepo();
    expect(await repo.load(), isEmpty);
  });
}
