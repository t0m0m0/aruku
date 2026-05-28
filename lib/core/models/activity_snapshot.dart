import 'package:flutter/foundation.dart';

import '../services/route_plan_builder.dart' show kcalPerKm;

/// 平均歩幅（メートル）。歩数から距離を換算する係数。
const double strideMeters = 0.75;

/// セッション/日次の活動計測結果（歩数・距離・消費カロリー）のスナップショット。
@immutable
class ActivitySnapshot {
  const ActivitySnapshot({
    required this.steps,
    required this.km,
    required this.kcal,
  });

  /// 歩数から距離（歩幅換算）と消費カロリー（[kcalPerKm] 換算）を導出する。
  factory ActivitySnapshot.fromSteps(int steps) {
    final km = steps * strideMeters / 1000;
    return ActivitySnapshot(
      steps: steps,
      km: km,
      kcal: (km * kcalPerKm).round(),
    );
  }

  final int steps;
  final double km;
  final int kcal;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ActivitySnapshot &&
          steps == other.steps &&
          km == other.km &&
          kcal == other.kcal;

  @override
  int get hashCode => Object.hash(steps, km, kcal);
}
