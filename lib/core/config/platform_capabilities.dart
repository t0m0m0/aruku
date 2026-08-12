/// プラットフォーム依存サービスを注入するかの判定。
///
/// Platform 判定を値ではなく関数で受けるのは、Web では `Platform.isIOS` の評価自体が
/// `UnsupportedError: Platform._operatingSystem` を投げるため。値渡しにすると引数が
/// 呼び出し前に評価され、`isWeb` を見る前に落ちる（dart2js の `dart:io` はスタブで、
/// コンパイルは通り触った瞬間に例外になる）。#359 参照。
library;

/// iOS 専用の HealthKit 連携を注入するか。
bool useHealthKit({required bool isWeb, required bool Function() isIOS}) =>
    !isWeb && isIOS();

/// ローカル通知の実体を注入するか。Web には実装がないため既定の no-op に残す。
bool useLocalNotifications({
  required bool isWeb,
  required bool Function() isIOS,
  required bool Function() isAndroid,
}) => !isWeb && (isIOS() || isAndroid());

/// 歩数計測にランタイムの権限要求が必要か。
///
/// iOS の CMPedometer は NSMotionUsageDescription を元に初回利用時へ自動でプロンプト
/// するため対象外。Web は pedometer に実装がなく、要求する権限自体が存在しない。
bool requiresActivityRecognitionPermission({
  required bool isWeb,
  required bool Function() isAndroid,
}) => !isWeb && isAndroid();
