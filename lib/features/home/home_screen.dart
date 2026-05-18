import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/app_constants.dart';
import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../picker/date_time_picker_sheet.dart';

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
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: c.paper,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: c.hairline),
                        ),
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
                  Container(
                    decoration: BoxDecoration(
                      color: c.paper,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: c.hairline),
                    ),
                    padding: const EdgeInsets.all(6),
                    child: IntrinsicHeight(
                      child: Row(
                        children: [
                          Expanded(
                            child: _TimeField(
                              label: '出発',
                              time: dep.format(),
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
                      label: '今日歩いた',
                      value: state.todayKm.toStringAsFixed(1),
                      unit: 'km',
                      leading: false,
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

class _DestinationCard extends StatelessWidget {
  const _DestinationCard({
    required this.departure,
    required this.destination,
    required this.onTapDeparture,
    required this.onTapDestination,
  });
  final String departure;
  final String? destination;
  final VoidCallback onTapDeparture;
  final VoidCallback onTapDestination;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      decoration: BoxDecoration(
        color: c.paper,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: c.hairline),
        boxShadow: const [
          BoxShadow(
            color: Color(0x0F22361E),
            blurRadius: 24,
            offset: Offset(0, 8),
          ),
        ],
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Stack(
        children: [
          // dot column
          Positioned(
            left: 16,
            top: 24,
            bottom: 24,
            child: Column(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: c.moss500,
                    shape: BoxShape.circle,
                    border: Border.all(color: c.moss100, width: 3),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Container(width: 2, color: c.moss200),
                  ),
                ),
                Ic.pin(size: 16, color: c.burnt, filled: true),
              ],
            ),
          ),
          Column(
            children: [
              // From
              InkWell(
                onTap: onTapDeparture,
                borderRadius: BorderRadius.circular(12),
                child: Ink(
                  padding: const EdgeInsets.fromLTRB(38, 12, 0, 12),
                  decoration: BoxDecoration(
                    border: Border(bottom: BorderSide(color: c.hairline)),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '出発',
                              style: jpStyle(
                                size: 11,
                                weight: FontWeight.w600,
                                color: c.ink3,
                                letterSpacing: 0.04 * 11,
                              ),
                            ),
                            Text(
                              departure,
                              style: jpStyle(
                                size: 16,
                                weight: FontWeight.w700,
                                color: c.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Ic.swap(size: 18, color: c.ink3),
                      ),
                    ],
                  ),
                ),
              ),
              // To
              InkWell(
                onTap: onTapDestination,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(38, 12, 0, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '目的地',
                              style: jpStyle(
                                size: 11,
                                weight: FontWeight.w600,
                                color: c.ink3,
                                letterSpacing: 0.04 * 11,
                              ),
                            ),
                            Text(
                              destination ?? 'タップして入力',
                              style: jpStyle(
                                size: 16,
                                weight: destination != null
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                                color: destination != null ? c.ink : c.ink3,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Ic.swap(size: 18, color: c.ink3),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _TimeField extends StatelessWidget {
  const _TimeField({
    required this.label,
    required this.time,
    required this.sub,
    required this.anchored,
    required this.onTap,
  });

  final String label;
  final String time;
  final String sub;
  final bool anchored;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: anchored ? c.moss50 : Colors.transparent,
            border: Border.all(
              color: anchored ? c.moss200 : Colors.transparent,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    label,
                    style: jpStyle(
                      size: 10,
                      weight: FontWeight.w800,
                      color: c.ink3,
                      letterSpacing: 0.08 * 10,
                    ),
                  ),
                  if (anchored) ...[
                    const SizedBox(width: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      decoration: BoxDecoration(
                        color: c.moss200,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        '固定',
                        style: jpStyle(
                          size: 9,
                          weight: FontWeight.w700,
                          color: c.moss700,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 1),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    time,
                    style: numStyle(
                      size: 20,
                      weight: FontWeight.w500,
                      color: c.ink,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      sub,
                      overflow: TextOverflow.ellipsis,
                      style: jpStyle(
                        size: 11,
                        weight: FontWeight.w600,
                        color: c.ink3,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SummaryItem extends StatelessWidget {
  const _SummaryItem({
    required this.label,
    required this.value,
    required this.unit,
    required this.leading,
  });
  final String label;
  final String value;
  final String unit;
  final bool leading;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Expanded(
      child: Container(
        padding: EdgeInsets.only(left: leading ? 16 : 0),
        decoration: leading
            ? BoxDecoration(
                border: Border(left: BorderSide(color: c.moss200)),
              )
            : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: jpStyle(
                size: 10,
                weight: FontWeight.w700,
                color: c.moss700,
                letterSpacing: 0.06 * 10,
              ),
            ),
            const SizedBox(height: 2),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  value,
                  style: numStyle(
                    size: 22,
                    weight: FontWeight.w600,
                    color: c.moss800,
                  ),
                ),
                const SizedBox(width: 3),
                Text(
                  unit,
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w700,
                    color: c.moss700,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchCTA extends StatelessWidget {
  const _SearchCTA({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.moss600,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(20),
        child: Ink(
          height: 60,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            boxShadow: const [
              BoxShadow(
                color: Color(0x5C35501A),
                blurRadius: 28,
                offset: Offset(0, 10),
              ),
            ],
          ),
          child: Center(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Ic.routes(size: 20, color: c.ivory),
                const SizedBox(width: 10),
                Text(
                  'ルートを検索',
                  style: jpStyle(
                    size: 18,
                    weight: FontWeight.w800,
                    color: c.ivory,
                    letterSpacing: 0.06 * 18,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
