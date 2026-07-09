import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/timezone.dart' as tz;

import '../../l10n/app_localizations.dart';
import 'notification_service.dart';

/// flutter_local_notifications を用いた [NotificationService] の実体。
///
/// iOS / Android の実機ビルドでのみ注入する（main.dart）。タイムゾーン DB の
/// 初期化（tz.initializeTimeZones / setLocalLocation）は呼び出し側で一度だけ
/// 行う前提で、ここでは [tz.local] を使って予約時刻を解釈する。
class LocalNotificationService implements NotificationService {
  LocalNotificationService({FlutterLocalNotificationsPlugin? plugin})
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;

  /// ストリーク途切れ警告の通知 ID。予約は常にこの ID を上書きし、取消も
  /// この ID を対象にする（同時に 1 件だけ存在させる）。
  static const int _streakReminderId = 1001;

  static const NotificationDetails _details = NotificationDetails(
    android: AndroidNotificationDetails(
      'streak_reminder',
      'ストリークリマインダー',
      channelDescription: '連続記録が途切れそうなときに知らせます。',
      importance: Importance.high,
      priority: Priority.high,
    ),
    iOS: DarwinNotificationDetails(),
  );

  bool _initialized = false;

  Future<void> _ensureInitialized() async {
    if (_initialized) return;
    // 権限は requestPermission で明示的に要求するため、初期化時には求めない。
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: false,
        requestBadgePermission: false,
        requestSoundPermission: false,
      ),
    );
    await _plugin.initialize(settings: settings);
    _initialized = true;
  }

  @override
  Future<bool> requestPermission() async {
    await _ensureInitialized();
    final ios = _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >();
    if (ios != null) {
      final granted = await ios.requestPermissions(
        alert: true,
        badge: true,
        sound: true,
      );
      return granted ?? false;
    }
    final android = _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    if (android != null) {
      final granted = await android.requestNotificationsPermission();
      return granted ?? false;
    }
    return false;
  }

  @override
  Future<void> scheduleStreakReminder({
    required DateTime when,
    required int streakDays,
  }) async {
    await _ensureInitialized();
    final l10n = lookupAppLocalizations(const Locale('ja'));
    await _plugin.zonedSchedule(
      id: _streakReminderId,
      title: l10n.notificationStreakReminderTitle,
      body: l10n.notificationStreakReminderBody(streakDays),
      scheduledDate: tz.TZDateTime.from(when, tz.local),
      notificationDetails: _details,
      // 途切れ警告は多少の遅延を許容できるため、SCHEDULE_EXACT_ALARM 権限を
      // 要さない inexact モードを使う。
      androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
    );
  }

  @override
  Future<void> cancelStreakReminder() async {
    await _ensureInitialized();
    await _plugin.cancel(id: _streakReminderId);
  }
}
