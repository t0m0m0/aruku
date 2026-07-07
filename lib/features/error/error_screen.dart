import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/route_error.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';

class ErrorScreen extends ConsumerWidget {
  const ErrorScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final kind =
        ref.watch(appStateProvider).routeErrorKind ?? RouteErrorKind.unknown;
    final l10n = AppLocalizations.of(context);
    final view = routeErrorView(l10n, kind);

    final retry = _Action(
      label: l10n.errorRetry,
      onTap: () => notifier.startSearch(),
    );
    final changeConditions = _Action(
      label: l10n.resultChangeConditions,
      onTap: () => notifier.go(Screen.home),
    );
    final back = _Action(
      label: l10n.resultBackToSearch,
      onTap: () => notifier.go(Screen.search),
    );
    final (
      primary,
      secondary,
    ) = view.primaryRecovery == RouteRecovery.changeConditions
        ? (changeConditions, retry)
        : (retry, back);

    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 84,
                  height: 84,
                  decoration: BoxDecoration(
                    color: c.paper,
                    shape: BoxShape.circle,
                    border: Border.all(color: c.hairline),
                  ),
                  child: Center(child: Ic.search(size: 32, color: c.ink3)),
                ),
                const SizedBox(height: 24),
                Text(
                  view.title,
                  textAlign: TextAlign.center,
                  style: jpStyle(
                    size: 20,
                    weight: FontWeight.w800,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  view.description,
                  textAlign: TextAlign.center,
                  style: jpStyle(
                    size: 13,
                    weight: FontWeight.w500,
                    color: c.ink3,
                  ),
                ),
                const SizedBox(height: 32),
                ArukuButton(label: primary.label, onPressed: primary.onTap),
                const SizedBox(height: 12),
                ArukuButton(
                  label: secondary.label,
                  onPressed: secondary.onTap,
                  variant: ArukuButtonVariant.outlined,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Action {
  const _Action({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;
}
