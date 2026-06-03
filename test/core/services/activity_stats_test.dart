import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/services/activity_stats.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  DailyActivity day(int month, int d, {int steps = 1000}) =>
      DailyActivity(date: DateTime(2026, month, d), steps: steps);

  group('computeStreak', () {
    test('履歴が空なら 0', () {
      expect(computeStreak(const [], DateTime(2026, 6, 3)), 0);
    });

    test('今日を含む連続日数を数える', () {
      final history = [day(6, 1), day(6, 2), day(6, 3)];
      expect(computeStreak(history, DateTime(2026, 6, 3)), 3);
    });

    test('今日がまだ未計測でも昨日までの連続は途切れない', () {
      // 今日(6/3)は記録なし。6/1・6/2 は活動済み。
      final history = [day(6, 1), day(6, 2)];
      expect(computeStreak(history, DateTime(2026, 6, 3)), 2);
    });

    test('途中に空白日があるとそこで途切れる', () {
      // 6/3 今日, 6/2 欠落, 6/1 活動 → 今日からの連続は 1
      final history = [day(6, 1), day(6, 3)];
      expect(computeStreak(history, DateTime(2026, 6, 3)), 1);
    });

    test('今日も昨日も未計測なら 0', () {
      final history = [day(6, 1)];
      expect(computeStreak(history, DateTime(2026, 6, 3)), 0);
    });

    test('歩数が閾値未満の日は活動日に数えない', () {
      final history = [day(6, 1), day(6, 2, steps: 0), day(6, 3)];
      expect(computeStreak(history, DateTime(2026, 6, 3)), 1);
    });
  });

  group('weekKm', () {
    test('月曜起点の今週分のみ合計する', () {
      // 2026-06-03 は水曜。週は月(6/1)〜日(6/7)。
      // 先週(5/31 日曜)は除外される。
      final history = [
        day(5, 31, steps: 1000), // 先週日曜 → 除外
        day(6, 1, steps: 1000), // 月
        day(6, 3, steps: 1000), // 水(今日)
      ];
      final km = weekKm(history, DateTime(2026, 6, 3));
      expect(km, closeTo(day(6, 1).km + day(6, 3).km, 1e-9));
    });

    test('履歴が空なら 0', () {
      expect(weekKm(const [], DateTime(2026, 6, 3)), 0.0);
    });

    test('月曜日当日も今週に含む', () {
      // 2026-06-01 は月曜。
      final history = [day(6, 1, steps: 2000)];
      expect(
        weekKm(history, DateTime(2026, 6, 1)),
        closeTo(day(6, 1, steps: 2000).km, 1e-9),
      );
    });
  });
}
