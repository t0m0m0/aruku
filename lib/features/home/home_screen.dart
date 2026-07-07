import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/app_constants.dart';
import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/state/settings_provider.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/km_format.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';
import '../picker/date_time_picker_sheet.dart';

part 'home_widgets.dart';

/// HIG 準拠のレイアウト定数（v2 `aruku-v2.css` の `--gutter` / `--safe-bottom` /
/// 8pt グリッドに対応）。画面全体で水平マージンをこの値に揃える。
const double _gutter = 20;
const double _safeBottom = 36;
const double _sp2 = 8;
const double _sp3 = 12;
const double _sp6 = 24;

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(appStateProvider);
    final notifier = ref.read(appStateProvider.notifier);
    final goalKm =
        ref.watch(settingsProvider).value?.weeklyGoalKm ??
        AppConstants.weeklyGoalKm;
    final destination = state.destination;
    final dep = state.departure;
    final arr = state.arrival;
    final budget = state.budgetMinutes;

    return Material(
      color: c.ivory,
      child: SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Greeting header（ストリークチップは下部の目標カードへ統合）
            Padding(
              padding: const EdgeInsets.fromLTRB(_gutter, _sp2, _gutter, _sp3),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          AppConstants.todayGreeting(l10n),
                          style: jpStyle(
                            size: 13,
                            weight: FontWeight.w600,
                            color: c.ink2,
                          ),
                        ),
                        const SizedBox(height: 2),
                        RichText(
                          text: TextSpan(
                            style: jpStyle(
                              size: 26,
                              weight: FontWeight.w800,
                              color: c.ink,
                              height: 1.15,
                              letterSpacing: -0.01 * 26,
                            ),
                            children: [
                              TextSpan(text: l10n.homeGreetingLead),
                              TextSpan(
                                text: l10n.homeGreetingHighlight,
                                style: TextStyle(color: c.moss600),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  GestureDetector(
                    key: const Key('home-settings-button'),
                    onTap: () => notifier.go(Screen.settings),
                    behavior: HitTestBehavior.opaque,
                    child: ArukuCard(
                      width: 44,
                      height: 44,
                      borderRadius: 14,
                      child: Center(
                        child: Ic.settings(size: 20, color: c.ink2),
                      ),
                    ),
                  ),
                ],
              ),
            ),

            // Destination card
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _gutter),
              child: _DestinationCard(
                departure: state.departureLabelText,
                destination: destination,
                onTapDeparture: () => notifier.go(Screen.searchOrigin),
                onTapDestination: () => notifier.go(Screen.search),
                onRefreshLocation: notifier.refreshLocation,
              ),
            ),

            // Time card
            Padding(
              padding: const EdgeInsets.fromLTRB(_gutter, _sp6, _gutter, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, _sp2),
                    child: Row(
                      children: [
                        Ic.clock(size: 12, color: c.ink2),
                        const SizedBox(width: 5),
                        Text(
                          l10n.homeTimeSectionLabel,
                          style: jpStyle(
                            size: 11,
                            weight: FontWeight.w800,
                            color: c.ink2,
                            letterSpacing: 0.08 * 11,
                          ),
                        ),
                        const Spacer(),
                        RichText(
                          text: TextSpan(
                            style: jpStyle(
                              size: 11,
                              weight: FontWeight.w600,
                              color: c.ink2,
                            ),
                            children: [
                              TextSpan(
                                text: TimeValue.formatBudget(budget),
                                style: TextStyle(
                                  color: c.moss600,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              TextSpan(text: l10n.homeWalkableSuffix),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  ArukuCard(
                    padding: const EdgeInsets.all(6),
                    child: IntrinsicHeight(
                      child: Row(
                        children: [
                          Expanded(
                            child: _TimeField(
                              key: const Key('time_field_depart'),
                              label: l10n.homeDepartureLabel,
                              time: dep.format(),
                              date: dep.dateLabel(),
                              onTap: () =>
                                  _pickDateTime(context, PickerMode.depart),
                            ),
                          ),
                          SizedBox(
                            width: 28,
                            child: Center(
                              child: Ic.chevron(
                                size: 14,
                                color: c.ink3,
                                dir: ChevronDir.right,
                              ),
                            ),
                          ),
                          Expanded(
                            child: _TimeField(
                              key: const Key('time_field_arrival'),
                              label: l10n.homeArrivalLabel,
                              time: arr.format(),
                              date: arr.dateLabel(),
                              onTap: () =>
                                  _pickDateTime(context, PickerMode.arrival),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            const Spacer(),

            // Weekly goal card — bottom, above CTA
            Padding(
              padding: const EdgeInsets.fromLTRB(_gutter, 0, _gutter, _sp6),
              child: _WeeklyGoalCard(
                goalKm: goalKm,
                weekKm: state.weekKm,
                todayKm: state.todayKm,
                todaySteps: state.todaySteps,
                todayKcal: state.todayKcal,
                streakDays: state.streakDays,
              ),
            ),

            // CTA — 目的地の有無でラベル・アイコン・遷移先が変わる
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _gutter,
                0,
                _gutter,
                _safeBottom,
              ),
              child: _SearchCTA(
                hasDestination: destination != null,
                onPressed: destination != null
                    ? () => notifier.startSearch()
                    : () => notifier.go(Screen.search),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

void _pickDateTime(BuildContext context, PickerMode mode) {
  showDateTimePickerSheet(context, initialMode: mode);
}
