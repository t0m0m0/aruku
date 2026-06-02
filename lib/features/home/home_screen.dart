import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/app_constants.dart';
import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';
import '../picker/date_time_picker_sheet.dart';

part 'home_widgets.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final state = ref.watch(appStateProvider);
    final notifier = ref.read(appStateProvider.notifier);
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
            // Greeting header
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 6, 24, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              AppConstants.todayGreeting(),
                              style: jpStyle(
                                size: 12,
                                weight: FontWeight.w600,
                                color: c.ink3,
                              ),
                            ),
                            const SizedBox(height: 2),
                            RichText(
                              text: TextSpan(
                                style: jpStyle(
                                  size: 24,
                                  weight: FontWeight.w800,
                                  color: c.ink,
                                  height: 1.2,
                                ),
                                children: [
                                  const TextSpan(text: '今日も、'),
                                  TextSpan(
                                    text: '歩こう。',
                                    style: TextStyle(color: c.moss600),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      ArukuCard(
                        width: 44,
                        height: 44,
                        borderRadius: 14,
                        child: Center(
                          child: Ic.settings(size: 20, color: c.ink2),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  // streak chip
                  Container(
                    padding: const EdgeInsets.fromLTRB(8, 5, 12, 5),
                    decoration: BoxDecoration(
                      color: c.burntSoft,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Ic.fire(size: 14, color: c.burnt),
                        const SizedBox(width: 6),
                        Text(
                          '${state.streakDays}日連続',
                          style: jpStyle(
                            size: 12,
                            weight: FontWeight.w700,
                            color: c.burnt,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '· 今週 ${state.weekKm.toStringAsFixed(1)}km',
                          style: jpStyle(
                            size: 12,
                            weight: FontWeight.w500,
                            color: c.burnt.withValues(alpha: 0.7),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),

            // Destination card
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: _DestinationCard(
                departure: state.departureLabelText,
                destination: destination,
                onTapDeparture: () => notifier.go(Screen.searchOrigin),
                onTapDestination: () => notifier.go(Screen.search),
              ),
            ),

            const SizedBox(height: 14),

            // Time card
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
                    child: Row(
                      children: [
                        Ic.clock(size: 12, color: c.ink2),
                        const SizedBox(width: 5),
                        Text(
                          '時間',
                          style: jpStyle(
                            size: 11,
                            weight: FontWeight.w800,
                            color: c.ink2,
                            letterSpacing: 0.12 * 11,
                          ),
                        ),
                        const Spacer(),
                        RichText(
                          text: TextSpan(
                            style: jpStyle(
                              size: 11,
                              weight: FontWeight.w600,
                              color: c.ink3,
                            ),
                            children: [
                              TextSpan(
                                text: TimeValue.formatBudget(budget),
                                style: TextStyle(
                                  color: c.moss600,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              const TextSpan(text: ' 歩いて移動'),
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
                              label: '出発',
                              time: dep.format(),
                              date: dep.dateLabel(),
                              sub: dep.isNow ? '今すぐ' : 'タップで変更',
                              anchored: !arr.anchored,
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
                              label: '到着',
                              time: arr.format(),
                              date: arr.dateLabel(),
                              sub: arr.anchored
                                  ? '指定時刻'
                                  : '+ ${TimeValue.formatBudget(budget)}',
                              anchored: arr.anchored,
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

            // Today summary
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: c.moss50,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Row(
                  children: [
                    _SummaryItem(
                      label: '歩数',
                      value: '${state.todaySteps}',
                      unit: '歩',
                      leading: false,
                    ),
                    _SummaryItem(
                      label: '今日歩いた',
                      value: state.todayKm.toStringAsFixed(1),
                      unit: 'km',
                      leading: true,
                    ),
                    _SummaryItem(
                      label: '消費',
                      value: '${state.todayKcal}',
                      unit: 'kcal',
                      leading: true,
                    ),
                    _SummaryItem(
                      label: '目標まで',
                      value: (10.0 - state.weekKm)
                          .clamp(0.0, 10.0)
                          .toStringAsFixed(1),
                      unit: 'km',
                      leading: true,
                    ),
                  ],
                ),
              ),
            ),

            const Spacer(),

            // CTA
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 38),
              child: _SearchCTA(onPressed: () => notifier.startSearch()),
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
