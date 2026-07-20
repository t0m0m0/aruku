import 'package:flutter/foundation.dart';

/// 経路結果画面をハブに、現在案内中の1区間だけを外部地図へ引き継ぐための行程進捗
/// （#305）。RoutePlan と対で持ち、経路が差し替わる・消えるときは同時に破棄する。
@immutable
class JourneyProgress {
  const JourneyProgress({
    required this.currentLegIndex,
    required this.startedAt,
    required this.startSteps,
    required this.startBaselineValid,
    required this.currentLegStartedAt,
  });

  /// RoutePlan.segments 上の、いま案内している区間の index。
  final int currentLegIndex;

  /// 行程を開始した時刻。
  final DateTime startedAt;

  /// 行程開始時点の当日累計歩数。
  final int startSteps;

  /// 開始時点で履歴ロードが完了し基準歩数が確定していたか。未確定（false）だと
  /// [startSteps] が 0 で捕捉され、完了時の差分に当日の既存歩数が混ざって過大計上に
  /// なるため、行程完了の HealthKit 書き込みをこのフラグでガードする（nav セッションの
  /// `_sessionBaselineValid` と同じ役割）。
  final bool startBaselineValid;

  /// 現在区間の計時を始めた時刻。徒歩区間はこの時刻を区間ワークアウトの開始とする。
  /// 前区間完了ではなく handoff（CTA 起動）時に合わせ、ハブ滞在・駅待ちを含めない。
  final DateTime currentLegStartedAt;

  JourneyProgress copyWith({
    int? currentLegIndex,
    DateTime? startedAt,
    int? startSteps,
    bool? startBaselineValid,
    DateTime? currentLegStartedAt,
  }) => JourneyProgress(
    currentLegIndex: currentLegIndex ?? this.currentLegIndex,
    startedAt: startedAt ?? this.startedAt,
    startSteps: startSteps ?? this.startSteps,
    startBaselineValid: startBaselineValid ?? this.startBaselineValid,
    currentLegStartedAt: currentLegStartedAt ?? this.currentLegStartedAt,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is JourneyProgress &&
          currentLegIndex == other.currentLegIndex &&
          startedAt == other.startedAt &&
          startSteps == other.startSteps &&
          startBaselineValid == other.startBaselineValid &&
          currentLegStartedAt == other.currentLegStartedAt;

  @override
  int get hashCode => Object.hash(
    currentLegIndex,
    startedAt,
    startSteps,
    startBaselineValid,
    currentLegStartedAt,
  );
}
