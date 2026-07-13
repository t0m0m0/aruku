import '../../l10n/app_localizations.dart';

class AppConstants {
  AppConstants._();

  static const int weeklyKcalEstimate = 1840;

  /// 週間ウォーキング目標距離（km）の既定値。
  static const double weeklyGoalKm = 10.0;

  /// 設定画面で選べる週間目標のプリセット（km、昇順）。
  static const List<double> weeklyGoalPresetsKm = [5.0, 10.0, 15.0, 20.0, 30.0];

  // 正式な利用規約・プライバシーポリシーの公開URLが未確定のためプレースホルダ。
  // 公開先が決まり次第、実URLへ差し替える。#281
  static const String termsOfServiceUrl = 'https://example.com/aruku/terms';
  static const String privacyPolicyUrl = 'https://example.com/aruku/privacy';

  static String todayDateLabel(AppLocalizations l10n) {
    final now = DateTime.now();
    final weekdays = [
      l10n.weekdayMon,
      l10n.weekdayTue,
      l10n.weekdayWed,
      l10n.weekdayThu,
      l10n.weekdayFri,
      l10n.weekdaySat,
      l10n.weekdaySun,
    ];
    final day = weekdays[now.weekday - 1];
    return '${l10n.dateMonthDayLabel(now.month, now.day)} ($day)';
  }

  static String todayGreeting(AppLocalizations l10n) {
    final now = DateTime.now();
    final greeting = now.hour < 12
        ? l10n.greetingMorning
        : now.hour < 18
        ? l10n.greetingAfternoon
        : l10n.greetingEvening;
    return '${todayDateLabel(l10n)} · $greeting';
  }
}
