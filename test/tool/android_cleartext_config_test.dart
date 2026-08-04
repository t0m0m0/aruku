import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// XML コメントは設定ではないので判定から外す。経緯を説明するコメントに
/// `usesCleartextTraffic` の語が出ただけで結果が変わらないようにする。
String _withoutComments(String xml) =>
    xml.replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

void main() {
  group('Android のマニフェスト', () {
    test('どのソースセットも平文 HTTP を許可しない', () {
      // ローカルの Functions エミュレータへ繋ぐために平文許可を足したくなるが、
      // 足しても繋がりやすくはならない。アプリの通信は package:http →
      // dart:io の HttpClient で、この許可を読む Java 層の NetworkSecurityPolicy
      // を通らないため既に平文が通る。足すと Java 層の保護だけが緩む。#349 参照。
      for (final sourceSet in const ['main', 'debug', 'profile']) {
        final manifest = _withoutComments(
          File(
            'android/app/src/$sourceSet/AndroidManifest.xml',
          ).readAsStringSync(),
        );

        expect(
          manifest,
          isNot(contains('usesCleartextTraffic')),
          reason: '$sourceSet が平文を許可している',
        );
        expect(
          manifest,
          isNot(contains('networkSecurityConfig')),
          reason: '$sourceSet がネットワークセキュリティ設定を差し替えている',
        );
      }
    });
  });
}
