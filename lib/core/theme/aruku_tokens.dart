import 'package:flutter/painting.dart';

/// テーマ非依存の固定デザイントークン。
///
/// 影・オーバーレイ・ルート区間色など、テーマ（[ArukuColors] のインスタンス）が
/// 切り替わっても変化しない値をここに集約する。すべて `static const` のため
/// `const [BoxShadow(...)]` のような const 文脈で利用できる。
class ArukuTokens {
  ArukuTokens._();

  // --- Route segment palette (shared by theme + map overlays) ---
  /// 徒歩区間のポリライン / `walk` テーマ色。
  static const Color routeWalk = Color(0xFF4F9527);

  /// 鉄道区間のポリライン / `train` テーマ色。
  static const Color routeTrain = Color(0xFF3E6792);

  // --- Elevation (shadow) tokens ---
  // アルファ値はコンポーネントごとの「浮き具合」を表す。
  /// ホームのサマリーカードなど、ごく控えめな落ち影。
  static const Color shadowCardSubtle = Color(0x0F22361E);

  /// 結果画面のカードの落ち影。
  static const Color shadowCard = Color(0x1422361E);

  /// オンボーディングのカードの落ち影。
  static const Color shadowCardSoft = Color(0x1A22361E);

  /// ナビの案内カードなど、強く浮かせる落ち影。
  static const Color shadowFloating = Color(0x4D22361E);

  /// ナビのチップ（Material elevation）の影。
  static const Color shadowChip = Color(0x1F000000);

  /// ナビ終了シートの影。
  static const Color shadowSheet = Color(0x2E000000);

  /// ホームの主要 CTA ボタンの影。
  static const Color shadowCtaPrimary = Color(0x5C35501A);

  /// 結果画面の CTA ボタンの影。
  static const Color shadowCtaResult = Color(0x5235501A);

  /// オンボーディングの CTA ボタンの影。
  static const Color shadowCtaOnboarding = Color(0x52496A24);

  /// ローディングのアイコンのグロー影。
  static const Color shadowGlow = Color(0x7335501A);

  /// ロゴの落ち影。
  static const Color shadowLogo = Color(0x3836501E);

  // --- Overlay / surface tokens ---
  /// ナビのチップの半透明サーフェス。
  static const Color navChipSurface = Color(0xE6FFFDF3);

  /// ナビの次々案内プレビューの濃緑サーフェス。
  static const Color navPreviewSurface = Color(0xC722361E);

  /// 濃色サーフェス上に重ねる半透明の白タイル。
  static const Color glassWhite = Color(0x24FFFFFF);

  /// 濃色（moss）背景上のテキスト/アイコン用の強い白。
  static const Color onMossStrong = Color(0xD9FFFFFF);
}
