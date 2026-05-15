import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'aruku_colors.dart';

/// Aruku — Wakaba theme.
class ArukuTheme {
  static ThemeData light() {
    const c = ArukuColors.wakaba;

    final base = ThemeData(
      brightness: Brightness.light,
      scaffoldBackgroundColor: c.ivory,
      colorScheme: const ColorScheme.light(
        primary: Color(0xFF4F9527),
        onPrimary: Color(0xFFFBFCEC),
        secondary: Color(0xFFF08338),
        onSecondary: Color(0xFFFBFCEC),
        surface: Color(0xFFFFFFF4),
        onSurface: Color(0xFF1D2418),
      ),
      useMaterial3: true,
      splashFactory: InkRipple.splashFactory,
    );

    return base.copyWith(
      extensions: const [c],
      textTheme: _buildTextTheme(c.ink),
    );
  }

  static TextTheme _buildTextTheme(Color ink) {
    final jp = GoogleFonts.mPlusRounded1cTextTheme();
    return jp.copyWith(
      displayLarge: jp.displayLarge?.copyWith(color: ink, fontWeight: FontWeight.w800),
      headlineLarge: jp.headlineLarge?.copyWith(color: ink, fontWeight: FontWeight.w800),
      headlineMedium: jp.headlineMedium?.copyWith(color: ink, fontWeight: FontWeight.w800),
      titleLarge: jp.titleLarge?.copyWith(color: ink, fontWeight: FontWeight.w800),
      titleMedium: jp.titleMedium?.copyWith(color: ink, fontWeight: FontWeight.w700),
      bodyLarge: jp.bodyLarge?.copyWith(color: ink, fontWeight: FontWeight.w500),
      bodyMedium: jp.bodyMedium?.copyWith(color: ink, fontWeight: FontWeight.w500),
      labelLarge: jp.labelLarge?.copyWith(color: ink, fontWeight: FontWeight.w700),
    );
  }
}

/// Tabular monospace number style — DM Mono.
TextStyle numStyle({
  required double size,
  FontWeight weight = FontWeight.w500,
  Color? color,
  double letterSpacing = -0.02,
}) {
  return GoogleFonts.dmMono(
    fontSize: size,
    fontWeight: weight,
    color: color,
    letterSpacing: letterSpacing * size,
    fontFeatures: const [FontFeature.tabularFigures()],
    height: 1.05,
  );
}

/// JP text style helper (M PLUS Rounded 1c).
TextStyle jpStyle({
  required double size,
  FontWeight weight = FontWeight.w500,
  Color? color,
  double? letterSpacing,
  double? height,
}) {
  return GoogleFonts.mPlusRounded1c(
    fontSize: size,
    fontWeight: weight,
    color: color,
    letterSpacing: letterSpacing,
    height: height,
  );
}

extension ArukuColorsX on BuildContext {
  ArukuColors get c => Theme.of(this).extension<ArukuColors>()!;
}
