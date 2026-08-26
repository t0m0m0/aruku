import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/layout_breakpoints.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../icons/ic.dart';
import 'logo.dart';

/// デスクトップ幅で全画面に被せる共通シェル（上部バー + 本文）。
///
/// go_router のルートツリーではなく Navigator の外側に置くのは、ルート定義を
/// 変えずに「遷移アニメへ巻き込まれない固定バー」を得るため。ShellRoute で
/// 包むと戻り先を表現しているネスト構造（settings/search/result/error→home）
/// に手を入れることになり、`AppState.screen` が router のミラーである前提の
/// 検証範囲が広がる。
class DesktopShell extends ConsumerWidget {
  const DesktopShell({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(isDesktopLayoutProvider)) return child;
    return ColoredBox(
      color: context.c.ivory,
      child: Column(
        children: [
          const SafeArea(bottom: false, child: _TopBar()),
          Expanded(
            // 各画面が自前の SafeArea を持つため、そのままでは同じ上部インセットが
            // バーの下でもう一度入る。バー側で消費済みとして落とす。
            child: MediaQuery.removePadding(
              context: context,
              removeTop: true,
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}

class _TopBar extends ConsumerWidget {
  const _TopBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final screen = ref.watch(appStateProvider.select((s) => s.screen));
    final notifier = ref.read(appStateProvider.notifier);
    // 設定以外の画面はすべて「ルートを計画」の下にある導線。
    final onSettings = screen == Screen.settings;

    // ローディングからの離脱は go だけでは足りない。screen だけ変えても探索は
    // 走り続け、完了時に startSearch が result / error へ引き戻す。モバイルは
    // PopScope で離脱経路自体を塞いでいるが、上部バーはそれを迂回する新しい
    // 出口なので、ここで明示的に打ち切る。
    void leave(Screen target) {
      if (screen == Screen.loading) {
        notifier.cancelSearch();
        if (target == Screen.home) return;
      }
      notifier.go(target);
    }

    return Container(
      key: const Key('desktop-shell-top-bar'),
      height: ArukuTokens.topBarHeight,
      decoration: BoxDecoration(
        color: c.paper,
        border: Border(bottom: BorderSide(color: c.hairline)),
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            maxWidth: ArukuTokens.contentMaxWidth,
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Row(
              children: [
                const ArukuLogo(size: 34),
                const SizedBox(width: 10),
                Text(
                  l10n.appTitle,
                  style: jpStyle(
                    size: 19,
                    weight: FontWeight.w900,
                    color: c.ink,
                    letterSpacing: 0.04 * 19,
                  ),
                ),
                const SizedBox(width: 20),
                _Tab(
                  id: 'plan',
                  label: l10n.shellTabPlan,
                  iconBuilder: (color) => Ic.routes(size: 16, color: color),
                  selected: !onSettings,
                  onTap: () => leave(Screen.home),
                ),
                const SizedBox(width: 4),
                _Tab(
                  id: 'settings',
                  label: l10n.shellTabSettings,
                  iconBuilder: (color) => Ic.settings(size: 16, color: color),
                  selected: onSettings,
                  onTap: () => leave(Screen.settings),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Tab extends StatelessWidget {
  const _Tab({
    required this.id,
    required this.label,
    required this.iconBuilder,
    required this.selected,
    required this.onTap,
  });

  final String id;
  final String label;
  final Widget Function(Color) iconBuilder;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final foreground = selected ? c.moss700 : c.ink2;
    return Semantics(
      key: Key('shell-tab-$id-semantics'),
      button: true,
      selected: selected,
      label: label,
      child: GestureDetector(
        key: Key('shell-tab-$id'),
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          height: 38,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: selected ? c.moss100 : Colors.transparent,
            borderRadius: BorderRadius.circular(11),
          ),
          child: Row(
            children: [
              iconBuilder(foreground),
              const SizedBox(width: 7),
              Text(
                label,
                style: jpStyle(
                  size: 14,
                  weight: FontWeight.w700,
                  color: foreground,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
