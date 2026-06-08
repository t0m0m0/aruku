import 'package:flutter/foundation.dart';

/// 距離・速度の表示単位。
enum DistanceUnit { kilometers, miles }

/// ユーザーが設定画面で変更できるアプリ設定。
/// SharedPreferences に JSON で永続化する（[toJson]/[fromJson]）。
@immutable
class AppSettings {
  const AppSettings({
    this.unit = DistanceUnit.kilometers,
    this.notificationsEnabled = true,
    this.defaultBudgetMinutes = 60,
  });

  /// 距離の表示単位。
  final DistanceUnit unit;

  /// 通知の許可フラグ。
  final bool notificationsEnabled;

  /// 経路検索時の既定の時間予算（分）。
  final int defaultBudgetMinutes;

  static const AppSettings defaults = AppSettings();

  AppSettings copyWith({
    DistanceUnit? unit,
    bool? notificationsEnabled,
    int? defaultBudgetMinutes,
  }) {
    return AppSettings(
      unit: unit ?? this.unit,
      notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
      defaultBudgetMinutes: defaultBudgetMinutes ?? this.defaultBudgetMinutes,
    );
  }

  Map<String, dynamic> toJson() => {
    'unit': unit.name,
    'notificationsEnabled': notificationsEnabled,
    'defaultBudgetMinutes': defaultBudgetMinutes,
  };

  static AppSettings fromJson(Map<String, dynamic> json) {
    final unitName = json['unit'];
    final notifications = json['notificationsEnabled'];
    final budget = json['defaultBudgetMinutes'];
    return AppSettings(
      unit: DistanceUnit.values.firstWhere(
        (u) => u.name == unitName,
        orElse: () => defaults.unit,
      ),
      notificationsEnabled: notifications is bool
          ? notifications
          : defaults.notificationsEnabled,
      defaultBudgetMinutes: budget is int
          ? budget
          : defaults.defaultBudgetMinutes,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppSettings &&
          unit == other.unit &&
          notificationsEnabled == other.notificationsEnabled &&
          defaultBudgetMinutes == other.defaultBudgetMinutes;

  @override
  int get hashCode =>
      Object.hash(unit, notificationsEnabled, defaultBudgetMinutes);
}
