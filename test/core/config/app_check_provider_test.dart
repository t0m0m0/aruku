import 'package:aruku/core/config/app_check_provider.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('useDebugAppCheckProvider', () {
    test('debug ビルドはトークン未指定でもデバッグプロバイダを使う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: true,
          isProfileBuild: false,
          debugToken: '',
        ),
        isTrue,
      );
    });

    test('debug ビルドはトークン指定時もデバッグプロバイダを使う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: true,
          isProfileBuild: false,
          debugToken: 'token',
        ),
        isTrue,
      );
    });

    test('profile ビルドはトークン指定時のみデバッグプロバイダを使う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: false,
          isProfileBuild: true,
          debugToken: 'token',
        ),
        isTrue,
      );
    });

    test('profile ビルドはトークン未指定なら証明プロバイダを使う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: false,
          isProfileBuild: true,
          debugToken: '',
        ),
        isFalse,
      );
    });

    test('profile ビルドは空白のみのトークンを指定なしとして扱う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: false,
          isProfileBuild: true,
          debugToken: '   ',
        ),
        isFalse,
      );
    });

    test('release ビルドはトークンを渡されても証明プロバイダを使う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: false,
          isProfileBuild: false,
          debugToken: 'token',
        ),
        isFalse,
      );
    });

    test('release ビルドはトークン未指定でも証明プロバイダを使う', () {
      expect(
        useDebugAppCheckProvider(
          isDebugBuild: false,
          isProfileBuild: false,
          debugToken: '',
        ),
        isFalse,
      );
    });
  });

  group('canActivateWebAppCheck', () {
    test('サイトキーがあれば有効化できる', () {
      expect(
        canActivateWebAppCheck(
          usesDebugProvider: false,
          recaptchaSiteKey: 'site-key',
        ),
        isTrue,
      );
    });

    test('デバッグプロバイダを使うならサイトキー無しでも有効化できる', () {
      // WebDebugProvider はトークン未指定でも JS SDK 側が自動生成する。
      expect(
        canActivateWebAppCheck(usesDebugProvider: true, recaptchaSiteKey: ''),
        isTrue,
      );
    });

    test('サイトキーも無くデバッグでもないなら有効化しない', () {
      // providerWeb を渡さない activate は同期的に throw し、await 先で未捕捉に
      // なってアプリが起動しない（#359）。
      expect(
        canActivateWebAppCheck(usesDebugProvider: false, recaptchaSiteKey: ''),
        isFalse,
      );
    });

    test('空白のみのサイトキーは未設定として扱う', () {
      expect(
        canActivateWebAppCheck(
          usesDebugProvider: false,
          recaptchaSiteKey: '   ',
        ),
        isFalse,
      );
    });
  });
}
