import 'dart:async';

import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

/// google_fonts はスタイル生成時にフォント実体の非同期ロードを開始する。
/// テスト環境では実体を取得しないためロードは失敗するが、検証したいのは
/// [TextStyle.fontFamily]（同期的に確定する）だけなので、失敗した非同期
/// ロードのエラーを隔離ゾーンで握りつぶして未処理エラーにしないようにする。
T _fontFamilyOnly<T>(T Function() body) {
  late T result;
  runZonedGuarded(() => result = body(), (_, __) {});
  return result;
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  group('フォントの Noto Sans JP 統一', () {
    bool isNotoSansJp(String? family) =>
        family != null && family.contains('NotoSansJP');

    bool isLegacyFont(String? family) =>
        family != null &&
        (family.contains('DMMono') || family.contains('MPLUSRounded1c'));

    test('numStyle は Noto Sans JP を使う', () {
      final style = _fontFamilyOnly(() => numStyle(size: 24));
      expect(isNotoSansJp(style.fontFamily), isTrue);
      expect(isLegacyFont(style.fontFamily), isFalse);
    });

    test('numStyle は tabular figures を維持する', () {
      final style = _fontFamilyOnly(() => numStyle(size: 24));
      expect(style.fontFeatures, contains(const FontFeature.tabularFigures()));
    });

    test('jpStyle は Noto Sans JP を使う', () {
      final style = _fontFamilyOnly(() => jpStyle(size: 16));
      expect(isNotoSansJp(style.fontFamily), isTrue);
      expect(isLegacyFont(style.fontFamily), isFalse);
    });

    test('TextTheme 本文は Noto Sans JP を使う', () {
      final theme = _fontFamilyOnly(ArukuTheme.light);
      final bodyMedium = theme.textTheme.bodyMedium;
      expect(bodyMedium, isNotNull);
      expect(isNotoSansJp(bodyMedium!.fontFamily), isTrue);
      expect(isLegacyFont(bodyMedium.fontFamily), isFalse);
    });

    test('見出しも Noto Sans JP を使う', () {
      final theme = _fontFamilyOnly(ArukuTheme.light);
      final headlineLarge = theme.textTheme.headlineLarge;
      expect(headlineLarge, isNotNull);
      expect(isNotoSansJp(headlineLarge!.fontFamily), isTrue);
    });
  });
}
