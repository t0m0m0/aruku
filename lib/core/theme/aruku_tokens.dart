import 'package:flutter/painting.dart';

/// テーマ非依存の固定デザイントークン。
///
/// 影・ルート区間色など、テーマ（[ArukuColors] のインスタンス）が
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

  /// ホームの主要 CTA ボタンの影。
  static const Color shadowCtaPrimary = Color(0x5C35501A);

  /// 結果画面の CTA ボタンの影。
  static const Color shadowCtaResult = Color(0x5235501A);

  /// ローディングのアイコンのグロー影。
  static const Color shadowGlow = Color(0x7335501A);
}
