import 'package:aruku/core/theme/aruku_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ArukuColors elevation/overlay tokens', () {
    test('影トークンが定義されている', () {
      expect(ArukuColors.shadowCardSubtle, const Color(0x0F22361E));
      expect(ArukuColors.shadowCard, const Color(0x1422361E));
      expect(ArukuColors.shadowCardSoft, const Color(0x1A22361E));
      expect(ArukuColors.shadowFloating, const Color(0x4D22361E));
      expect(ArukuColors.shadowChip, const Color(0x1F000000));
      expect(ArukuColors.shadowSheet, const Color(0x2E000000));
      expect(ArukuColors.shadowCtaPrimary, const Color(0x5C35501A));
      expect(ArukuColors.shadowCtaResult, const Color(0x5235501A));
      expect(ArukuColors.shadowCtaOnboarding, const Color(0x52496A24));
      expect(ArukuColors.shadowGlow, const Color(0x7335501A));
      expect(ArukuColors.shadowLogo, const Color(0x3836501E));
    });

    test('オーバーレイ/サーフェストークンが定義されている', () {
      expect(ArukuColors.navChipSurface, const Color(0xE6FFFDF3));
      expect(ArukuColors.navPreviewSurface, const Color(0xC722361E));
      expect(ArukuColors.glassWhite, const Color(0x24FFFFFF));
      expect(ArukuColors.onMossStrong, const Color(0xD9FFFFFF));
    });

    test('ルート区間色トークンが walk/train テーマ色と一致する', () {
      expect(ArukuColors.routeWalk, const Color(0xFF4F9527));
      expect(ArukuColors.routeTrain, const Color(0xFF3E6792));
      expect(ArukuColors.routeWalk, ArukuColors.wakaba.walk);
      expect(ArukuColors.routeTrain, ArukuColors.wakaba.train);
    });
  });
}
