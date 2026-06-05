import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/daily_activity.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DailyActivity', () {
    test('日付は年月日に正規化される（時刻は切り捨て）', () {
      final entry = DailyActivity(
        date: DateTime(2026, 6, 3, 14, 35, 12),
        steps: 1000,
      );
      expect(entry.date, DateTime(2026, 6, 3));
    });

    test('km / kcal は歩数から ActivitySnapshot と同じ換算で導出する', () {
      final entry = DailyActivity(date: DateTime(2026, 6, 3), steps: 1000);
      final snap = ActivitySnapshot.fromSteps(1000);
      expect(entry.km, snap.km);
      expect(entry.kcal, snap.kcal);
    });

    test('JSON へ往復しても等価', () {
      final entry = DailyActivity(date: DateTime(2026, 6, 3), steps: 1234);
      final restored = DailyActivity.fromJson(entry.toJson());
      expect(restored, entry);
    });

    test('dateKey は yyyy-MM-dd 形式（ゼロ埋め）', () {
      final entry = DailyActivity(date: DateTime(2026, 1, 5), steps: 0);
      expect(entry.dateKey, '2026-01-05');
    });

    test('同じ日付・歩数なら等価', () {
      expect(
        DailyActivity(date: DateTime(2026, 6, 3), steps: 500),
        DailyActivity(date: DateTime(2026, 6, 3), steps: 500),
      );
    });
  });
}
