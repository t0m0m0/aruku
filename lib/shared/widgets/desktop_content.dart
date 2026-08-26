import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/layout_breakpoints.dart';

/// デスクトップ幅でのみ本文を [maxWidth] で頭打ちにし、中央へ寄せる。
///
/// モバイル幅で [child] を素通しするのは、`< 820px` の見た目を1ピクセルも
/// 変えないため。包んだ画面のモバイル側テストが無変更で通ることが、iOS /
/// Android へ影響していないことの根拠になる。
class DesktopContent extends ConsumerWidget {
  const DesktopContent({
    super.key,
    required this.maxWidth,
    required this.child,
  });

  final double maxWidth;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(isDesktopLayoutProvider)) return child;
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: KeyedSubtree(key: const Key('desktop-content'), child: child),
      ),
    );
  }
}
