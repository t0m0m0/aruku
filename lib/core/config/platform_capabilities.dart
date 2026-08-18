/// プラットフォーム依存サービスを注入するかの判定。
///
/// Platform 判定を値ではなく関数で受けるのは、Web では `Platform.isIOS` の評価自体が
/// `UnsupportedError: Platform._operatingSystem` を投げるため。値渡しにすると引数が
/// 呼び出し前に評価され、`isWeb` を見る前に落ちる（dart2js の `dart:io` はスタブで、
/// コンパイルは通り触った瞬間に例外になる）。#359 参照。
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// iOS 専用の HealthKit 連携を注入するか。
bool useHealthKit({required bool isWeb, required bool Function() isIOS}) =>
    !isWeb && isIOS();

/// ローカル通知の実体を注入するか。Web には実装がないため既定の no-op に残す。
bool useLocalNotifications({
  required bool isWeb,
  required bool Function() isIOS,
  required bool Function() isAndroid,
}) => !isWeb && (isIOS() || isAndroid());

/// 歩数センサーを購読できるか。pedometer は Web をプラグイン対象に含めていない。
///
/// 「購読して失敗させる」ではなく事前に諦めるのは、失敗が
/// MissingPluginException として例外側へ出るだけで、歩数が一生 0 のまま理由を
/// 残さないから。非対応を値として持てば UI が理由を出せる（#359 Phase 2）。
bool supportsStepCounting({required bool isWeb}) => !isWeb;

/// 実地図（GoogleMap）を描画できるか。[flagEnabled] は USE_REAL_MAP の値。
///
/// Web でフラグを無視するのは、google_maps_flutter_web が Maps JavaScript SDK を
/// 要求する一方、web/index.html がまだ読み込んでいないため。読み込みには Web 用に
/// リファラ制限した別枠のキーが要る（#359 Phase 2b）。フラグを通すと地図が描画
/// できず、スタイライズド地図へのフォールバックも効かない。
bool supportsRealMap({required bool isWeb, required bool flagEnabled}) =>
    flagEnabled && !isWeb;

/// OS のアプリ設定画面を開けるか。
///
/// Web の権限はブラウザのサイト設定側にあり、permission_handler の
/// openAppSettings は何も開かない——例外も出ないため、押しても無反応の導線が残る。
bool canOpenOsSettings({required bool isWeb}) => !isWeb;

/// [canOpenOsSettings] の値。UI から kIsWeb を直接読むと非対応時の見た目が
/// Web でしか検証できないため注入可能にする。専用のサービス層を持たない
/// 機能（permission_handler の直呼び）なので、置き場所はここになる。
final canOpenOsSettingsProvider = Provider<bool>(
  (_) => canOpenOsSettings(isWeb: kIsWeb),
);

/// 未捕捉エラーを Crashlytics へ流すハンドラを登録するか。
///
/// Web を外すのは Crashlytics に Web 実装が無いから、では足りない。登録すると
/// `PlatformDispatcher.onError` が true（処理済み）を返してブラウザ既定の未捕捉
/// エラー報告を抑止する一方、報告先の future は失敗して呼び出し側の `.ignore()` に
/// 飲まれる。結果として記録も表示も残らない。既定の報告経路に任せる方がまだ見える。
bool useCrashHandlers({required bool isWeb, required bool isRelease}) =>
    isRelease && !isWeb;

/// 歩数計測にランタイムの権限要求が必要か。
///
/// iOS の CMPedometer は NSMotionUsageDescription を元に初回利用時へ自動でプロンプト
/// するため対象外。Web は pedometer に実装がなく、要求する権限自体が存在しない。
bool requiresActivityRecognitionPermission({
  required bool isWeb,
  required bool Function() isAndroid,
}) => !isWeb && isAndroid();
