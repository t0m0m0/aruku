/// ビューポート幅によるレイアウト切替の判定。
///
/// プラットフォーム（`kIsWeb`）ではなく幅で判定するのは、デスクトップブラウザの
/// ウィンドウを狭めたときにモバイル UI が出るのが正しい挙動だから。逆に幅の広い
/// タブレットは Web でなくてもデスクトップ相当の余白を扱える。#372 参照。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// デスクトップレイアウトへ切り替えるビューポート幅（論理ピクセル）。
const double kDesktopBreakpoint = 820;

/// [width] のビューポートにデスクトップレイアウトを出すか。
bool isDesktopWidth(double width) => width >= kDesktopBreakpoint;

/// デスクトップレイアウトを出すか。`ResponsiveScope` が実測幅で上書きする。
///
/// 既定を `false`（モバイル）に倒すのは、`ResponsiveScope` を通らない経路
/// ——widget test や将来の別 entry point——が、本番に存在しない UI を出さない
/// ようにするため。既定を `true` にすると通し忘れが新しい画面として露出する。
///
/// このプロバイダに依存するプロバイダを増やさないこと。`ResponsiveScope` は
/// 入れ子の `ProviderScope` で override するため、依存側は入れ子のコンテナで
/// 再生成され、ルート側と状態が二重化する。
final isDesktopLayoutProvider = Provider<bool>((_) => false);
