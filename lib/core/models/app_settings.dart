import 'package:flutter/foundation.dart';

import '../constants/app_constants.dart';

/// ユーザーが設定画面で変更できるアプリ設定。
/// SharedPreferences に JSON で永続化する（[toJson]/[fromJson]）。
@immutable
class AppSettings {
  const AppSettings({
    this.notificationsEnabled = true,
    this.weeklyGoalKm = AppConstants.weeklyGoalKm,
    this.healthKitEnabled = false,
  });

  /// 通知の許可フラグ。
  final bool notificationsEnabled;

  /// 週間ウォーキング目標距離（km）。常に正の値。
  final double weeklyGoalKm;

  /// HealthKit（Apple ヘルスケア）連携の有効フラグ。オプトインのため既定はオフ。
  /// オンのとき歩行セッションをワークアウトとして書き込む。
  final bool healthKitEnabled;

  static const AppSettings defaults = AppSettings();

  AppSettings copyWith({
    bool? notificationsEnabled,
    double? weeklyGoalKm,
    bool? healthKitEnabled,
  }) {
    return AppSettings(
      notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
      weeklyGoalKm: weeklyGoalKm ?? this.weeklyGoalKm,
      healthKitEnabled: healthKitEnabled ?? this.healthKitEnabled,
    );
  }

  Map<String, dynamic> toJson() => {
    'notificationsEnabled': notificationsEnabled,
    'weeklyGoalKm': weeklyGoalKm,
    'healthKitEnabled': healthKitEnabled,
  };

  static AppSettings fromJson(Map<String, dynamic> json) {
    final notifications = json['notificationsEnabled'];
    final goal = json['weeklyGoalKm'];
    final healthKit = json['healthKitEnabled'];
    return AppSettings(
      notificationsEnabled: notifications is bool
          ? notifications
          : defaults.notificationsEnabled,
      // 破損・不正値（非数値・0以下）は既定値へフォールバックする。
      weeklyGoalKm: goal is num && goal > 0
          ? goal.toDouble()
          : defaults.weeklyGoalKm,
      healthKitEnabled: healthKit is bool
          ? healthKit
          : defaults.healthKitEnabled,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppSettings &&
          notificationsEnabled == other.notificationsEnabled &&
          weeklyGoalKm == other.weeklyGoalKm &&
          healthKitEnabled == other.healthKitEnabled;

  @override
  int get hashCode =>
      Object.hash(notificationsEnabled, weeklyGoalKm, healthKitEnabled);
}
