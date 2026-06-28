import 'package:flutter/foundation.dart';

import 'app_settings.dart';
import 'daily_activity.dart';
import 'favorite_place.dart';
import 'recent_place.dart';

/// アカウントに紐付けてクラウド同期する、端末ローカルデータのスナップショット。
///
/// 衝突解決は document 単位の last-write-wins（[mergeLww]）。スナップショット全体に
/// 1 つの [updatedAt] を持ち、新しい側で丸ごと上書きする。粒度の細かい
/// セクション別マージは将来の調整余地として残す。
@immutable
class SyncData {
  const SyncData({
    required this.updatedAt,
    required this.settings,
    required this.favorites,
    required this.recents,
    required this.recentOrigins,
    required this.activity,
  });

  /// このスナップショットがローカルで最後に更新された時刻（UTC 推奨）。
  final DateTime updatedAt;
  final AppSettings settings;
  final List<FavoritePlace> favorites;
  final List<RecentPlace> recents;
  final List<RecentPlace> recentOrigins;
  final List<DailyActivity> activity;

  /// last-write-wins で勝った側を返す。同時刻はローカルを優先し、不要な
  /// ローカル上書きを避ける。
  static SyncData mergeLww({
    required SyncData local,
    required SyncData remote,
  }) {
    return remote.updatedAt.isAfter(local.updatedAt) ? remote : local;
  }

  Map<String, dynamic> toJson() => {
    'updatedAt': updatedAt.toUtc().toIso8601String(),
    'settings': settings.toJson(),
    'favorites': favorites.map((e) => e.toJson()).toList(),
    'recents': recents.map((e) => e.toJson()).toList(),
    'recentOrigins': recentOrigins.map((e) => e.toJson()).toList(),
    'activity': activity.map((e) => e.toJson()).toList(),
  };

  static SyncData fromJson(Map<String, dynamic> json) {
    final updatedAt = json['updatedAt'];
    final settings = json['settings'];
    return SyncData(
      updatedAt: updatedAt is String
          ? (DateTime.tryParse(updatedAt) ?? _epoch)
          : _epoch,
      settings: settings is Map<String, dynamic>
          ? AppSettings.fromJson(settings)
          : AppSettings.defaults,
      favorites: _list(json['favorites'], FavoritePlace.fromJson),
      recents: _list(json['recents'], RecentPlace.fromJson),
      recentOrigins: _list(json['recentOrigins'], RecentPlace.fromJson),
      activity: _list(json['activity'], DailyActivity.fromJson),
    );
  }

  static List<T> _list<T>(
    Object? raw,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(fromJson)
        .toList(growable: false);
  }

  static final DateTime _epoch = DateTime.fromMillisecondsSinceEpoch(
    0,
    isUtc: true,
  );
}
