import 'package:flutter/foundation.dart';

/// 歩行完了時のシェア用サマリー。ナビ到着（または手動完了）時に確定し、
/// 完了画面（[Screen.complete]）で画像化してシェアするための最小データ。
@immutable
class WalkSummary {
  const WalkSummary({
    required this.distanceKm,
    required this.kcal,
    required this.from,
    required this.to,
  });

  /// 実際に歩いた徒歩距離（km）。電車区間は含まない。
  final double distanceKm;

  /// 歩行で消費したカロリー。
  final int kcal;

  final String from;
  final String to;
}
