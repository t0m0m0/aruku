import 'package:aruku/core/config/app_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const expectedAndroidToken = String.fromEnvironment(
    'TEST_EXPECTED_ANDROID_APP_CHECK_DEBUG_TOKEN',
  );
  const expectedAppleToken = String.fromEnvironment(
    'TEST_EXPECTED_APPLE_APP_CHECK_DEBUG_TOKEN',
  );

  test('reads separate App Check debug tokens for Android and Apple', () {
    expect(AppConfig.androidAppCheckDebugToken, expectedAndroidToken);
    expect(AppConfig.appleAppCheckDebugToken, expectedAppleToken);
  });
}
