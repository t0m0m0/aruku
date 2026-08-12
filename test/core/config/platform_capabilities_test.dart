import 'package:aruku/core/config/platform_capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  /// 呼ばれたことを記録する Platform 判定。Web で評価されないことの反証に使う。
  ({bool Function() probe, bool Function() wasCalled}) recording(bool value) {
    var called = false;
    return (
      probe: () {
        called = true;
        return value;
      },
      wasCalled: () => called,
    );
  }

  group('useHealthKit', () {
    test('iOS でのみ HealthKit を注入する', () {
      expect(useHealthKit(isWeb: false, isIOS: () => true), isTrue);
      expect(useHealthKit(isWeb: false, isIOS: () => false), isFalse);
    });

    test('Web では Platform を評価せずに無効化する', () {
      final ios = recording(true);
      expect(useHealthKit(isWeb: true, isIOS: ios.probe), isFalse);
      expect(ios.wasCalled(), isFalse);
    });
  });

  group('useLocalNotifications', () {
    test('iOS / Android で有効、それ以外のネイティブでは無効', () {
      expect(
        useLocalNotifications(
          isWeb: false,
          isIOS: () => true,
          isAndroid: () => false,
        ),
        isTrue,
      );
      expect(
        useLocalNotifications(
          isWeb: false,
          isIOS: () => false,
          isAndroid: () => true,
        ),
        isTrue,
      );
      expect(
        useLocalNotifications(
          isWeb: false,
          isIOS: () => false,
          isAndroid: () => false,
        ),
        isFalse,
      );
    });

    test('Web では Platform を評価せずに無効化する', () {
      final ios = recording(true);
      final android = recording(true);
      expect(
        useLocalNotifications(
          isWeb: true,
          isIOS: ios.probe,
          isAndroid: android.probe,
        ),
        isFalse,
      );
      expect(ios.wasCalled(), isFalse);
      expect(android.wasCalled(), isFalse);
    });
  });

  group('supportsStepCounting', () {
    test('ネイティブでは計測できる / Web ではできない', () {
      expect(supportsStepCounting(isWeb: false), isTrue);
      expect(supportsStepCounting(isWeb: true), isFalse);
    });
  });

  group('useCrashHandlers', () {
    test('release のネイティブでのみ登録する', () {
      expect(useCrashHandlers(isWeb: false, isRelease: true), isTrue);
      expect(useCrashHandlers(isWeb: false, isRelease: false), isFalse);
    });

    test('release Web では登録しない', () {
      // 登録すると PlatformDispatcher.onError が true を返してブラウザ既定の
      // 未捕捉エラー報告を抑止する一方、Crashlytics には Web 実装が無く報告も
      // 残らない。記録も表示も消える無音化になる（#359）。
      expect(useCrashHandlers(isWeb: true, isRelease: true), isFalse);
    });
  });

  group('requiresActivityRecognitionPermission', () {
    test('Android のみランタイム要求が必要', () {
      expect(
        requiresActivityRecognitionPermission(
          isWeb: false,
          isAndroid: () => true,
        ),
        isTrue,
      );
      expect(
        requiresActivityRecognitionPermission(
          isWeb: false,
          isAndroid: () => false,
        ),
        isFalse,
      );
    });

    test('Web では Platform を評価せずに不要と判定する', () {
      final android = recording(true);
      expect(
        requiresActivityRecognitionPermission(
          isWeb: true,
          isAndroid: android.probe,
        ),
        isFalse,
      );
      expect(android.wasCalled(), isFalse);
    });
  });
}
