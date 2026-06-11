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
  });

  /// 距離の表示単位。
  final DistanceUnit unit;

  /// 通知の許可フラグ。
  final bool notificationsEnabled;

  static const AppSettings defaults = AppSettings();

  AppSettings copyWith({DistanceUnit? unit, bool? notificationsEnabled}) {
    return AppSettings(
      unit: unit ?? this.unit,
      notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
    );
  }

  Map<String, dynamic> toJson() => {
    'unit': unit.name,
    'notificationsEnabled': notificationsEnabled,
  };

  static AppSettings fromJson(Map<String, dynamic> json) {
    final unitName = json['unit'];
    final notifications = json['notificationsEnabled'];
    return AppSettings(
      unit: DistanceUnit.values.firstWhere(
        (u) => u.name == unitName,
        orElse: () => defaults.unit,
      ),
      notificationsEnabled: notifications is bool
          ? notifications
          : defaults.notificationsEnabled,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppSettings &&
          unit == other.unit &&
          notificationsEnabled == other.notificationsEnabled;

  @override
  int get hashCode => Object.hash(unit, notificationsEnabled);
}
