import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/services/notification_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('NoopNotificationService', () {
    test('requestPermission は false（連携先なし）', () async {
      const service = NoopNotificationService();
      expect(await service.requestPermission(), isFalse);
    });

    test('schedule / cancel は例外なく no-op', () async {
      const service = NoopNotificationService();
      await service.scheduleStreakReminder(
        when: DateTime(2026, 7, 9, 20),
        streakDays: 3,
      );
      await service.cancelStreakReminder();
    });
  });

  group('planStreakReminder', () {
    // [today] を含まない、昨日から [days] 日連続の活動履歴。
    List<DailyActivity> streakEndingYesterday(DateTime today, int days) => [
      for (var i = 1; i <= days; i++)
        DailyActivity(date: today.subtract(Duration(days: i)), steps: 5000),
    ];

    test('守るべきストリークがあり通知時刻前ならスケジュール', () {
      final now = DateTime(2026, 7, 9, 12);
      final plan = planStreakReminder(
        history: streakEndingYesterday(now, 3),
        now: now,
        reminderHour: 20,
      );
      expect(plan, isA<ScheduleStreakReminder>());
      final schedule = plan as ScheduleStreakReminder;
      expect(schedule.streakDays, 3);
      expect(schedule.when, DateTime(2026, 7, 9, 20));
    });

    test('今日すでに活動済みならキャンセル', () {
      final now = DateTime(2026, 7, 9, 12);
      final history = [
        ...streakEndingYesterday(now, 3),
        DailyActivity(date: now, steps: 6000),
      ];
      expect(
        planStreakReminder(history: history, now: now, reminderHour: 20),
        const CancelStreakReminder(),
      );
    });

    test('守るストリークがなければキャンセル', () {
      final now = DateTime(2026, 7, 9, 12);
      expect(
        planStreakReminder(history: const [], now: now, reminderHour: 20),
        const CancelStreakReminder(),
      );
    });

    test('通知時刻を過ぎていればキャンセル', () {
      final now = DateTime(2026, 7, 9, 21);
      expect(
        planStreakReminder(
          history: streakEndingYesterday(now, 3),
          now: now,
          reminderHour: 20,
        ),
        const CancelStreakReminder(),
      );
    });

    test('昨日途切れている（今日も昨日も未活動）ならキャンセル', () {
      final now = DateTime(2026, 7, 9, 12);
      final history = [
        DailyActivity(date: now.subtract(const Duration(days: 2)), steps: 5000),
        DailyActivity(date: now.subtract(const Duration(days: 3)), steps: 5000),
      ];
      expect(
        planStreakReminder(history: history, now: now, reminderHour: 20),
        const CancelStreakReminder(),
      );
    });

    test('活動歩数が minSteps 未満の日は連続に数えない', () {
      final now = DateTime(2026, 7, 9, 12);
      final history = [
        DailyActivity(date: now.subtract(const Duration(days: 1)), steps: 0),
        DailyActivity(date: now.subtract(const Duration(days: 2)), steps: 5000),
      ];
      expect(
        planStreakReminder(history: history, now: now, reminderHour: 20),
        const CancelStreakReminder(),
      );
    });
  });
}
