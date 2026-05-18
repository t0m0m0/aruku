import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/route_error.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';

class ErrorScreen extends ConsumerWidget {
  const ErrorScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final kind =
        ref.watch(appStateProvider).routeErrorKind ?? RouteErrorKind.unknown;
    final view = routeErrorView(kind);

    final retry = _Action(label: '再試行', onTap: () => notifier.startSearch());
    final changeConditions = _Action(
      label: '条件を変更',
      onTap: () => notifier.go(Screen.home),
    );
    final back = _Action(
      label: '検索に戻る',
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
                _PrimaryButton(label: primary.label, onTap: primary.onTap),
                const SizedBox(height: 12),
                _SecondaryButton(
                  label: secondary.label,
                  onTap: secondary.onTap,
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

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.moss600,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          width: double.infinity,
          height: 52,
          alignment: Alignment.center,
          child: Text(
            label,
            style: jpStyle(size: 16, weight: FontWeight.w800, color: c.ivory),
          ),
        ),
      ),
    );
  }
}

class _SecondaryButton extends StatelessWidget {
  const _SecondaryButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.paper,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Ink(
          width: double.infinity,
          height: 52,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: c.hairline),
          ),
          child: Center(
            child: Text(
              label,
              style: jpStyle(size: 16, weight: FontWeight.w700, color: c.ink),
            ),
          ),
        ),
      ),
    );
  }
}
