import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/favorite_place.dart';
import '../../core/models/route_plan.dart';
import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/state/favorites_provider.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';

part 'result_totals.dart';
part 'result_timeline.dart';

class ResultScreen extends ConsumerWidget {
  const ResultScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final notifier = ref.read(appStateProvider.notifier);
    final state = ref.watch(appStateProvider);
    final favorites =
        ref.watch(favoritesProvider).value ?? const <FavoritePlace>[];
    final route = state.route;
    if (route == null) {
      return Material(
        color: c.ivory,
        child: SafeArea(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  l10n.resultNoRouteMessage,
                  style: jpStyle(
                    size: 18,
                    weight: FontWeight.w800,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 16),
                Material(
                  color: c.moss600,
                  borderRadius: BorderRadius.circular(16),
                  child: InkWell(
                    onTap: () => notifier.go(Screen.search),
                    borderRadius: BorderRadius.circular(16),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 28,
                        vertical: 14,
                      ),
                      child: Text(
                        l10n.resultBackToSearch,
                        style: jpStyle(
                          size: 15,
                          weight: FontWeight.w800,
                          color: c.ivory,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Column(
          children: [
            // Mini header
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
              child: Row(
                children: [
                  _HeaderButton(
                    semanticLabel: l10n.commonBack,
                    child: Ic.chevron(
                      size: 18,
                      color: c.ink,
                      dir: ChevronDir.left,
                    ),
                    onTap: () => notifier.go(Screen.home),
                  ),
                  Expanded(
                    child: Center(
                      child: Text(
                        l10n.resultDepartureLabel(
                          state.departure.fullDateLabel(),
                          state.departure.format(),
                        ),
                        style: jpStyle(
                          size: 12,
                          weight: FontWeight.w700,
                          color: c.ink3,
                        ),
                      ),
                    ),
                  ),
                  Builder(
                    builder: (context) {
                      final place = FavoritePlace(
                        name: state.destination ?? route.to,
                        latLng: state.destinationLatLng,
                      );
                      final isFav = favorites.any(
                        (e) => e.dedupeKey == place.dedupeKey,
                      );
                      return _HeaderButton(
                        key: const ValueKey('result-star-button'),
                        semanticLabel: isFav
                            ? l10n.resultRemoveFavorite
                            : l10n.resultAddFavorite,
                        child: Ic.star(
                          size: 18,
                          color: isFav ? c.moss600 : c.ink,
                          filled: isFav,
                        ),
                        onTap: () => unawaited(
                          ref.read(favoritesProvider.notifier).toggle(place),
                        ),
                      );
                    },
                  ),
                ],
              ),
            ),

            if (route.totalMin > route.budgetMin)
              _OverBudgetBanner(
                overMin: route.totalMin - route.budgetMin,
                onChange: () => notifier.go(Screen.home),
              ),

            // Journey card
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
                child: ArukuCard(
                  borderRadius: 24,
                  shadow: const [
                    BoxShadow(
                      color: ArukuTokens.shadowCard,
                      blurRadius: 28,
                      offset: Offset(0, 12),
                    ),
                  ],
                  padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
                  child: Column(
                    children: [
                      _JourneyHeader(route: route),
                      const SizedBox(height: 14),
                      _TotalsStrip(route: route),
                      const SizedBox(height: 12),
                      _WalkRatioRow(route: route),
                      const SizedBox(height: 14),
                      Expanded(child: _Timeline(route: route)),
                      const SizedBox(height: 8),
                      _CtaRow(onNav: () => notifier.go(Screen.nav)),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OverBudgetBanner extends StatelessWidget {
  const _OverBudgetBanner({required this.overMin, required this.onChange});
  final int overMin;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 0, 14, 4),
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
      decoration: BoxDecoration(
        color: c.burnt.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: c.burnt.withValues(alpha: 0.24)),
      ),
      child: Row(
        children: [
          Ic.search(size: 18, color: c.burnt),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.resultOverBudgetTitle(overMin),
                  style: jpStyle(
                    size: 13,
                    weight: FontWeight.w800,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  // 予算内に間に合う経路が無いため best-effort（最短）を表示して
                  // いる状態。検索失敗のように見せず、最短経路を出している旨を伝える。
                  l10n.resultOverBudgetHint,
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w500,
                    color: c.ink3,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Material(
            color: c.burnt,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              onTap: onChange,
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                child: Text(
                  l10n.resultChangeConditions,
                  style: jpStyle(
                    size: 12,
                    weight: FontWeight.w800,
                    color: c.ivory,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _HeaderButton extends StatelessWidget {
  const _HeaderButton({
    required this.child,
    required this.onTap,
    required this.semanticLabel,
    super.key,
  });
  final Widget child;
  final VoidCallback onTap;

  /// アイコンのみのボタンのため、VoiceOver 用にラベルを必須で受け取る。
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: c.paper,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Ink(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: c.hairline),
            ),
            child: Center(child: child),
          ),
        ),
      ),
    );
  }
}

class _JourneyHeader extends StatelessWidget {
  const _JourneyHeader({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'FROM',
                style: jpStyle(
                  size: 10,
                  weight: FontWeight.w800,
                  color: c.moss600,
                  letterSpacing: 0.12 * 10,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                route.from,
                style: jpStyle(size: 16, weight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                'TO',
                style: jpStyle(
                  size: 10,
                  weight: FontWeight.w800,
                  color: c.burnt,
                  letterSpacing: 0.12 * 10,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                route.to,
                textAlign: TextAlign.end,
                style: jpStyle(size: 16, weight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _CtaRow extends StatelessWidget {
  const _CtaRow({required this.onNav});
  final VoidCallback onNav;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return Row(
      children: [
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(
            color: c.paper,
            border: Border.all(color: c.hairline),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Center(child: Ic.search(size: 18, color: c.ink2)),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: ArukuButton(
            label: l10n.resultWalkThisRoute,
            onPressed: onNav,
            icon: Ic.arrowUp(size: 18, color: c.ivory),
            iconGap: 8,
            shadow: const [
              BoxShadow(
                color: ArukuTokens.shadowCtaResult,
                blurRadius: 20,
                offset: Offset(0, 8),
              ),
            ],
            textStyle: jpStyle(
              size: 16,
              weight: FontWeight.w800,
              color: c.ivory,
              letterSpacing: 0.06 * 16,
            ),
          ),
        ),
      ],
    );
  }
}
