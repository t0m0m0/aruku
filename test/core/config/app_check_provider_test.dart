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
}
