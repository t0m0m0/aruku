import 'package:flutter/material.dart';

/// Aruku design tokens — Wakaba (default) theme.
/// See design_handoff_aruku_mvp/design-reference/tokens.css
@immutable
class ArukuColors extends ThemeExtension<ArukuColors> {
  const ArukuColors({
    required this.moss50,
    required this.moss100,
    required this.moss200,
    required this.moss300,
    required this.moss400,
    required this.moss500,
    required this.moss600,
    required this.moss700,
    required this.moss800,
    required this.ivory,
    required this.paper,
    required this.sand,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.ink4,
    required this.hairline,
    required this.walk,
    required this.train,
    required this.trainSoft,
    required this.burnt,
    required this.burntSoft,
    required this.danger,
    required this.dangerSoft,
    required this.gold,
    required this.mapBg,
    required this.mapRoad,
    required this.mapMajor,
    required this.mapPark,
    required this.mapWater,
    required this.mapBuild,
    required this.mapLabel,
  });

  final Color moss50;
  final Color moss100;
  final Color moss200;
  final Color moss300;
  final Color moss400;
  final Color moss500;
  final Color moss600;
  final Color moss700;
  final Color moss800;
  final Color ivory;
  final Color paper;
  final Color sand;
  final Color ink;
  final Color ink2;
  final Color ink3;
  final Color ink4;
  final Color hairline;
  final Color walk;
  final Color train;
  final Color trainSoft;
  final Color burnt;
  final Color burntSoft;
  final Color danger;
  final Color dangerSoft;
  final Color gold;
  final Color mapBg;
  final Color mapRoad;
  final Color mapMajor;
  final Color mapPark;
  final Color mapWater;
  final Color mapBuild;
  final Color mapLabel;

  // Wakaba (若葉) — the chosen default per README
  static const wakaba = ArukuColors(
    moss50: Color(0xFFEEF8E0),
    moss100: Color(0xFFDBF0B7),
    moss200: Color(0xFFB9E27C),
    moss300: Color(0xFF92CC4A),
    moss400: Color(0xFF6FB342),
    moss500: Color(0xFF4F9527),
    moss600: Color(0xFF387418),
    moss700: Color(0xFF2A5511),
    moss800: Color(0xFF1B3A0B),
    ivory: Color(0xFFFBFCEC),
    paper: Color(0xFFFFFFF4),
    sand: Color(0xFFEEF1DC),
    ink: Color(0xFF1D2418),
    ink2: Color(0xFF4A5645),
    ink3: Color(0xFF8A9583),
    ink4: Color(0xFFC8CFC1),
    hairline: Color(0x141D2418),
    walk: Color(0xFF4F9527),
    train: Color(0xFF3E6792),
    trainSoft: Color(0xFFC9D8E8),
    burnt: Color(0xFFF08338),
    burntSoft: Color(0xFFFCE2CE),
    danger: Color(0xFFC8412F),
    dangerSoft: Color(0xFFF8DAD4),
    gold: Color(0xFFD2A03A),
    mapBg: Color(0xFFEFEBDD),
    mapRoad: Color(0xFFFFFFFF),
    mapMajor: Color(0xFFF7E4A0),
    mapPark: Color(0xFFDDE7C7),
    mapWater: Color(0xFFBFD3DD),
    mapBuild: Color(0xFFE5DFCC),
    mapLabel: Color(0xFF6E6A57),
  );

  @override
  ArukuColors copyWith() => this;

  @override
  ArukuColors lerp(ThemeExtension<ArukuColors>? other, double t) => this;
}
