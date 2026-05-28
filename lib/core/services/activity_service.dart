import 'dart:io' show Platform;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pedometer/pedometer.dart';
import 'package:permission_handler/permission_handler.dart';

import '../models/activity_snapshot.dart';

/// セッション/日次の歩数・距離・kcal を計測するサービス。
abstract interface class ActivityService {
  /// 計測に必要な権限を要求する。許可されたら true。
  Future<bool> requestPermission();

  /// セッション開始時点を基準とした活動量のストリーム。
  Stream<ActivitySnapshot> sessionActivityStream();
}

class PedometerActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async {
    // iOS の CMPedometer は NSMotionUsageDescription を元に初回利用時へ自動で
    // プロンプトするため、ランタイム要求は Android の ACTIVITY_RECOGNITION のみ。
    if (!Platform.isAndroid) return true;
    final status = await Permission.activityRecognition.request();
    return status.isGranted;
  }

  @override
  Stream<ActivitySnapshot> sessionActivityStream() {
    // stepCountStream は端末起動以降の累積歩数を返すため、最初の値を基準に
    // 差分を取りセッション内の歩数へ変換する。
    int? baseline;
    return Pedometer.stepCountStream.map((event) {
      baseline ??= event.steps;
      return ActivitySnapshot.fromSteps(event.steps - baseline!);
    });
  }
}

final activityServiceProvider = Provider<ActivityService>(
  (_) => PedometerActivityService(),
);
