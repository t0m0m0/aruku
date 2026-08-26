import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/layout_breakpoints.dart';

/// ビューポート幅を [isDesktopLayoutProvider] へ流し込む。
///
/// 各画面が `MediaQuery` を直読みしないのは、幅の両側を検証する widget test が
/// そのたびに `MediaQuery` を積む作業になるから。注入点を1つに絞れば、テストは
/// [isDesktopLayoutProvider] の override だけで両側を作れる。
class ResponsiveScope extends StatelessWidget {
  const ResponsiveScope({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      overrides: [
        isDesktopLayoutProvider.overrideWithValue(
          isDesktopWidth(MediaQuery.sizeOf(context).width),
        ),
      ],
      child: child,
    );
  }
}
