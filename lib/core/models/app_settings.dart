import 'package:flutter/foundation.dart';

/// ユーザーが設定画面で変更できるアプリ設定。
/// SharedPreferences に JSON で永続化する（[toJson]/[fromJson]）。
@immutable
class AppSettings {
  const AppSettings({this.notificationsEnabled = true});

  /// 通知の許可フラグ。
  final bool notificationsEnabled;

  static const AppSettings defaults = AppSettings();

  AppSettings copyWith({bool? notificationsEnabled}) {
    return AppSettings(
      notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
    );
  }

  Map<String, dynamic> toJson() => {
    'notificationsEnabled': notificationsEnabled,
  };

  static AppSettings fromJson(Map<String, dynamic> json) {
    final notifications = json['notificationsEnabled'];
    return AppSettings(
      notificationsEnabled: notifications is bool
          ? notifications
          : defaults.notificationsEnabled,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppSettings &&
          notificationsEnabled == other.notificationsEnabled;

  @override
  int get hashCode => notificationsEnabled.hashCode;
}
