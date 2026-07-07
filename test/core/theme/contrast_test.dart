import 'dart:math' as math;

import 'package:aruku/core/theme/aruku_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// sRGB チャンネル値(0..1)を相対輝度計算用の線形値へ変換する。
/// WCAG 2.x の定義に準拠。
double _linearize(double channel) {
  return channel <= 0.03928
      ? channel / 12.92
      : math.pow((channel + 0.055) / 1.055, 2.4).toDouble();
}

/// WCAG 相対輝度 (0.0=黒, 1.0=白)。
double _relativeLuminance(Color color) {
  final r = _linearize(color.r);
  final g = _linearize(color.g);
  final b = _linearize(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/// 2色間の WCAG コントラスト比 (1.0〜21.0)。
double _contrastRatio(Color a, Color b) {
  final la = _relativeLuminance(a);
  final lb = _relativeLuminance(b);
  final lighter = math.max(la, lb);
  final darker = math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

void main() {
  const c = ArukuColors.wakaba;

  // WCAG AA: 通常サイズテキストは 4.5:1 以上。
  const aaNormal = 4.5;

  group('コントラスト比 (WCAG AA)', () {
    test('ink3 は主要背景(ivory/paper/sand)に対し 4.5:1 以上', () {
      // ink3 は 12〜14px の補助テキストに広く使われるため通常テキスト基準で判定する。
      expect(
        _contrastRatio(c.ink3, c.ivory),
        greaterThanOrEqualTo(aaNormal),
        reason: 'ink3 on ivory',
      );
      expect(
        _contrastRatio(c.ink3, c.paper),
        greaterThanOrEqualTo(aaNormal),
        reason: 'ink3 on paper',
      );
      expect(
        _contrastRatio(c.ink3, c.sand),
        greaterThanOrEqualTo(aaNormal),
        reason: 'ink3 on sand',
      );
    });

    test('ink / ink2 (本文・見出し) も背景に対し 4.5:1 以上を維持', () {
      for (final bg in [c.ivory, c.paper, c.sand]) {
        expect(_contrastRatio(c.ink, bg), greaterThanOrEqualTo(aaNormal));
        expect(_contrastRatio(c.ink2, bg), greaterThanOrEqualTo(aaNormal));
      }
    });
  });
}
