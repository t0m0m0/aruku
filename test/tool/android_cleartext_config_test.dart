import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// XML コメントは設定ではないので判定から外す。経緯を説明するコメントに
/// `usesCleartextTraffic` の語が出ただけで結果が変わらないようにする。
String _withoutComments(String xml) =>
    xml.replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

/// ソースセット名 → マニフェスト本文。
///
/// 対象を列挙で持たないのは、ソースセットが後から増えるため。release 用や
/// product flavor 用のマニフェストが足されたとき、固定リストだと走査から漏れて
/// 静かに緑になる。
Map<String, String> _sourceSetManifests() {
  final entries = Directory(
    'android/app/src',
  ).listSync().whereType<Directory>();

  return {
    for (final dir in entries)
      if (File('${dir.path}/AndroidManifest.xml').existsSync())
        dir.uri.pathSegments[dir.uri.pathSegments.length - 2]: _withoutComments(
          File('${dir.path}/AndroidManifest.xml').readAsStringSync(),
        ),
  };
}

void main() {
  group('Android のマニフェスト', () {
    test('どのソースセットも平文 HTTP を許可しない', () {
      // ローカルの Functions エミュレータへ繋ぐために平文許可を足したくなるが、
      // 足しても繋がりやすくはならない。アプリの通信は package:http →
      // dart:io の HttpClient で、この許可を読む Java 層の NetworkSecurityPolicy
      // を通らないため既に平文が通る。足すと Java 層の保護だけが緩む。#349 参照。
      //
      // マージ済みマニフェストを見れば AAR 依存が持ち込む同種の指定も拾えるが、
      // 生成には Gradle ビルドと Android SDK が要り、flutter test を Android
      // ツールチェーン依存にしてしまう。ここで止めたいのは上記の誤診断に対する
      // 手直しなので、リポジトリが持つマニフェストだけを対象にしている。
      final manifests = _sourceSetManifests();

      // 走査が空振りしたまま緑になるのを防ぐ。
      expect(manifests.keys, containsAll(<String>['main', 'debug', 'profile']));

      for (final MapEntry(key: sourceSet, value: manifest)
          in manifests.entries) {
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
