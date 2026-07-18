import 'package:flutter/foundation.dart';

/// 経路結果画面をハブに、現在案内中の1区間だけを外部地図へ引き継ぐための行程進捗
/// （#305）。RoutePlan と対で持ち、経路が差し替わる・消えるときは同時に破棄する。
@immutable
class JourneyProgress {
  const JourneyProgress({
    required this.currentLegIndex,
    required this.startedAt,
    required this.startSteps,
  });

  /// RoutePlan.segments 上の、いま案内している区間の index。
  final int currentLegIndex;

  /// 行程を開始した時刻。
  final DateTime startedAt;

  /// 行程開始時点の当日累計歩数。
  final int startSteps;

  JourneyProgress copyWith({
    int? currentLegIndex,
    DateTime? startedAt,
    int? startSteps,
  }) => JourneyProgress(
    currentLegIndex: currentLegIndex ?? this.currentLegIndex,
    startedAt: startedAt ?? this.startedAt,
    startSteps: startSteps ?? this.startSteps,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is JourneyProgress &&
          currentLegIndex == other.currentLegIndex &&
          startedAt == other.startedAt &&
          startSteps == other.startSteps;

  @override
  int get hashCode => Object.hash(currentLegIndex, startedAt, startSteps);
}
