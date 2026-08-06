import 'package:aruku/core/theme/aruku_colors.dart';
import 'package:aruku/core/theme/aruku_tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ArukuTokens elevation/overlay tokens', () {
    test('影トークンが規定値を保持する', () {
      expect(ArukuTokens.shadowCardSubtle, const Color(0x0F22361E));
      expect(ArukuTokens.shadowCard, const Color(0x1422361E));
      expect(ArukuTokens.shadowCardSoft, const Color(0x1A22361E));
      expect(ArukuTokens.shadowCtaPrimary, const Color(0x5C35501A));
      expect(ArukuTokens.shadowCtaResult, const Color(0x5235501A));
      expect(ArukuTokens.shadowCtaOnboarding, const Color(0x52496A24));
      expect(ArukuTokens.shadowGlow, const Color(0x7335501A));
      expect(ArukuTokens.shadowLogo, const Color(0x3836501E));
    });

    test('ルート区間色トークンが walk/train テーマ色と一致する', () {
      expect(ArukuTokens.routeWalk, const Color(0xFF4F9527));
      expect(ArukuTokens.routeTrain, const Color(0xFF3E6792));
      expect(ArukuTokens.routeWalk, ArukuColors.wakaba.walk);
      expect(ArukuTokens.routeTrain, ArukuColors.wakaba.train);
    });
  });
}
