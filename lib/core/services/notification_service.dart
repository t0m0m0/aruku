import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/daily_activity.dart';
import 'activity_stats.dart';

/// ストリーク途切れ警告を通知するローカル時刻（時, 24h）。夕方以降に
/// 「今日まだ歩いていない」ことへ気付けるよう既定は 20 時。
const int kStreakReminderHour = 20;

/// ローカル通知サービス。
///
/// 既定実装は [NoopNotificationService]（何もしない）。実機ビルドでのみ
/// flutter_local_notifications を用いた実体を注入し、[notificationServiceProvider]
/// を上書きする。
abstract interface class NotificationService {
  /// 通知権限を要求する。許可されたら true。
  Future<bool> requestPermission();

  /// ストリーク途切れ警告を [when]（ローカル時刻）にスケジュールする。
  /// 継続 [streakDays] 日を守るための文言を出す。既存の予約は置き換える。
  Future<void> scheduleStreakReminder({
    required DateTime when,
    required int streakDays,
  });

  /// スケジュール済みのストリーク途切れ警告を取り消す。
  Future<void> cancelStreakReminder();
}

/// 連携先を持たない既定実装。プラグイン未導入の環境（テスト・シミュレータ・
/// 権限拒否時）で安全に no-op として振る舞う。
class NoopNotificationService implements NotificationService {
  const NoopNotificationService();

  @override
  Future<bool> requestPermission() async => false;

  @override
  Future<void> scheduleStreakReminder({
    required DateTime when,
    required int streakDays,
  }) async {}

  @override
  Future<void> cancelStreakReminder() async {}
}

final notificationServiceProvider = Provider<NotificationService>(
  (_) => const NoopNotificationService(),
);

/// ストリーク途切れ警告のスケジュール判断。純粋関数で副作用を持たない。
@immutable
sealed class StreakReminderPlan {
  const StreakReminderPlan();
}

/// 今日の [when] に、継続 [streakDays] 日を守る警告を出す。
@immutable
class ScheduleStreakReminder extends StreakReminderPlan {
  const ScheduleStreakReminder({required this.when, required this.streakDays});

  /// 通知を出すローカル時刻（今日）。
  final DateTime when;

  /// 途切れさせたくない現在の連続活動日数。
  final int streakDays;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ScheduleStreakReminder &&
          when == other.when &&
          streakDays == other.streakDays;

  @override
  int get hashCode => Object.hash(when, streakDays);
}

/// 警告は不要（今日は活動済み／守るストリークがない／通知時刻を過ぎた）。
@immutable
class CancelStreakReminder extends StreakReminderPlan {
  const CancelStreakReminder();

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is CancelStreakReminder;

  @override
  int get hashCode => 0;
}

/// [history] と現在時刻 [now] から、今日出すべきストリーク途切れ警告を判断する。
///
/// 今日が未活動で、昨日まで [minSteps] 以上の活動が連続しており、まだ通知時刻
/// [reminderHour] 前であれば [ScheduleStreakReminder] を返す。それ以外
/// （今日活動済み・守るストリークなし・時刻超過）は [CancelStreakReminder]。
StreakReminderPlan planStreakReminder({
  required Iterable<DailyActivity> history,
  required DateTime now,
  int reminderHour = kStreakReminderHour,
  int minSteps = kStreakMinSteps,
}) {
  final todayKey = DailyActivity(date: now, steps: 0).dateKey;
  var todaySteps = 0;
  for (final e in history) {
    if (e.dateKey == todayKey) {
      todaySteps = e.steps;
      break;
    }
  }
  // 今日すでに活動済みなら守れているので警告不要。
  if (todaySteps >= minSteps) return const CancelStreakReminder();

  // 今日が未活動のとき computeStreak は昨日起点の連続日数（＝守るべき
  // ストリーク）を返す。0 なら守るものがない。
  final streak = computeStreak(history, now, minSteps: minSteps);
  if (streak <= 0) return const CancelStreakReminder();

  final when = DateTime(now.year, now.month, now.day, reminderHour);
  // 通知時刻を過ぎていれば今日はもう出さない。
  if (!now.isBefore(when)) return const CancelStreakReminder();

  return ScheduleStreakReminder(when: when, streakDays: streak);
}
