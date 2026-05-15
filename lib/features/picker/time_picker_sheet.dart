import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';

class TimePickerSheet extends ConsumerWidget {
  const TimePickerSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final state = ref.watch(appStateProvider);
    final picker = state.picker;
    if (picker == null) return const SizedBox.shrink();

    final notifier = ref.read(appStateProvider.notifier);
    final dep = state.departure;
    final curBudget =
        (picker.h * 60 + picker.m) - (dep.h * 60 + dep.m);

    return Material(
      color: c.paper,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Grip
              Padding(
                padding: const EdgeInsets.only(top: 10, bottom: 4),
                child: Container(
                  width: 38,
                  height: 4,
                  decoration: BoxDecoration(
                    color: c.ink4,
                    borderRadius: BorderRadius.circular(999),
                  ),
                ),
              ),
              // Title + close
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 4, 18, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: Text('時刻を選ぶ',
                          style: jpStyle(
                              size: 17,
                              weight: FontWeight.w800,
                              color: c.ink)),
                    ),
                    InkWell(
                      onTap: notifier.closePicker,
                      borderRadius: BorderRadius.circular(10),
                      child: Container(
                        width: 30,
                        height: 30,
                        alignment: Alignment.center,
                        child: Ic.close(size: 18, color: c.ink3),
                      ),
                    ),
                  ],
                ),
              ),
              // Mode toggle
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
                child: Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: c.moss50,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      _ModeButton(
                        active: picker.mode == PickerMode.depart,
                        label: '出発時刻',
                        icon: Ic.walk(size: 14, color: c.ink2),
                        activeIcon: Ic.walk(size: 14, color: c.moss700),
                        onTap: () => notifier.switchPickerMode(PickerMode.depart),
                      ),
                      _ModeButton(
                        active: picker.mode == PickerMode.arrival,
                        label: '到着時刻',
                        icon: Ic.flag(size: 14, color: c.ink2),
                        activeIcon: Ic.flag(size: 14, color: c.moss700),
                        onTap: () =>
                            notifier.switchPickerMode(PickerMode.arrival),
                      ),
                    ],
                  ),
                ),
              ),
              // Quick chips
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                child: _QuickChips(picker: picker, departure: dep),
              ),
              // Wheel
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: SizedBox(
                  height: 200,
                  child: Stack(
                    children: [
                      // Center highlight band
                      Positioned(
                        left: 12,
                        right: 12,
                        top: 78,
                        height: 44,
                        child: IgnorePointer(
                          child: Container(
                            decoration: BoxDecoration(
                              color: c.moss50,
                              border: Border.all(color: c.moss100),
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                        ),
                      ),
                      // Wheels
                      Row(
                        children: [
                          Expanded(
                            child: _Wheel(
                              values: List.generate(24, (i) => i),
                              current: picker.h,
                              suffix: '時',
                              onChange: (v) => notifier.updatePicker(h: v),
                            ),
                          ),
                          Text(':',
                              style: numStyle(
                                  size: 26,
                                  weight: FontWeight.w500,
                                  color: c.ink)),
                          Expanded(
                            child: _Wheel(
                              values:
                                  List.generate(12, (i) => i * 5),
                              current: picker.m,
                              suffix: '分',
                              onChange: (v) => notifier.updatePicker(m: v),
                            ),
                          ),
                        ],
                      ),
                      // Fades
                      Positioned(
                        left: 0,
                        right: 0,
                        top: 0,
                        height: 40,
                        child: IgnorePointer(
                          child: Container(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [c.paper, c.paper.withValues(alpha: 0)],
                              ),
                            ),
                          ),
                        ),
                      ),
                      Positioned(
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 40,
                        child: IgnorePointer(
                          child: Container(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.bottomCenter,
                                end: Alignment.topCenter,
                                colors: [c.paper, c.paper.withValues(alpha: 0)],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 4),
              // Meta
              if (picker.mode == PickerMode.arrival)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: RichText(
                    textAlign: TextAlign.center,
                    text: TextSpan(
                      style: jpStyle(
                          size: 12, weight: FontWeight.w500, color: c.ink3),
                      children: [
                        const TextSpan(text: '制限時間: '),
                        TextSpan(
                          text: TimeValue.formatBudgetJp(curBudget),
                          style: TextStyle(
                              color: c.moss700,
                              fontWeight: FontWeight.w800),
                        ),
                        const TextSpan(text: ' · 出発 '),
                        TextSpan(
                          text: dep.format(),
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                  ),
                )
              else
                Text('出発をこの時刻に設定',
                    style: jpStyle(
                        size: 12, weight: FontWeight.w500, color: c.ink3)),

              // Confirm
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 12, 18, 0),
                child: Material(
                  color: c.moss600,
                  borderRadius: BorderRadius.circular(16),
                  child: InkWell(
                    onTap: notifier.confirmPicker,
                    borderRadius: BorderRadius.circular(16),
                    child: Ink(
                      height: 52,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(16),
                        boxShadow: const [
                          BoxShadow(
                              color: Color(0x5235501A),
                              blurRadius: 20,
                              offset: Offset(0, 8)),
                        ],
                      ),
                      child: Center(
                        child: Text(
                          'この時刻に決定',
                          style: jpStyle(
                              size: 16,
                              weight: FontWeight.w800,
                              color: c.ivory,
                              letterSpacing: 0.06 * 16),
                        ),
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
}

class _ModeButton extends StatelessWidget {
  const _ModeButton({
    required this.active,
    required this.label,
    required this.icon,
    required this.activeIcon,
    required this.onTap,
  });

  final bool active;
  final String label;
  final Widget icon;
  final Widget activeIcon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Expanded(
      child: Material(
        color: active ? c.paper : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
        elevation: active ? 1 : 0,
        shadowColor: const Color(0x14000000),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(9),
          child: SizedBox(
            height: 36,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                active ? activeIcon : icon,
                const SizedBox(width: 6),
                Text(label,
                    style: jpStyle(
                        size: 13,
                        weight: FontWeight.w800,
                        color: active ? c.moss700 : c.ink2)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _QuickChips extends ConsumerWidget {
  const _QuickChips({required this.picker, required this.departure});
  final PickerState picker;
  final TimeValue departure;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final chips = <_ChipData>[];
    if (picker.mode == PickerMode.depart) {
      chips.addAll([
        _ChipData('今すぐ', departure.h, departure.m),
        _ChipData('10:00', 10, 0),
        _ChipData('12:00', 12, 0),
        _ChipData('18:00', 18, 0),
      ]);
    } else {
      for (final d in const [30, 60, 90, 120, 180, 360]) {
        final total = (departure.h * 60 + departure.m + d) % (24 * 60);
        final label = d == 30
            ? '+30分'
            : d == 60
                ? '+1h'
                : d == 90
                    ? '+1.5h'
                    : d == 120
                        ? '+2h'
                        : d == 180
                            ? '+3h'
                            : '+半日';
        chips.add(_ChipData(label, total ~/ 60, total % 60));
      }
    }

    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: chips.map((d) {
        final active = d.h == picker.h && d.m == picker.m;
        return InkWell(
          onTap: () {
            notifier.updatePicker(h: d.h, m: d.m);
          },
          borderRadius: BorderRadius.circular(999),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: active ? c.moss100 : c.ivory,
              border: Border.all(
                  color: active ? c.moss300 : c.hairline),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(d.label,
                style: jpStyle(
                    size: 12,
                    weight: FontWeight.w700,
                    color: active ? c.moss700 : c.ink2)),
          ),
        );
      }).toList(),
    );
  }
}

class _ChipData {
  _ChipData(this.label, this.h, this.m);
  final String label;
  final int h;
  final int m;
}

class _Wheel extends StatelessWidget {
  const _Wheel({
    required this.values,
    required this.current,
    required this.suffix,
    required this.onChange,
  });

  final List<int> values;
  final int current;
  final String suffix;
  final ValueChanged<int> onChange;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final controller = FixedExtentScrollController(
        initialItem: values.indexOf(current));
    return CupertinoPicker(
      scrollController: controller,
      itemExtent: 40,
      magnification: 1.0,
      squeeze: 1.1,
      useMagnifier: false,
      selectionOverlay: const SizedBox.shrink(),
      onSelectedItemChanged: (i) => onChange(values[i]),
      children: values.map((v) {
        final isCenter = v == current;
        return Center(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(v.toString().padLeft(2, '0'),
                  style: numStyle(
                      size: isCenter ? 26 : 20,
                      weight:
                          isCenter ? FontWeight.w500 : FontWeight.w400,
                      color: isCenter ? c.ink : c.ink2)),
              if (isCenter) ...[
                const SizedBox(width: 4),
                Text(suffix,
                    style: jpStyle(
                        size: 12,
                        weight: FontWeight.w700,
                        color: c.ink2)),
              ],
            ],
          ),
        );
      }).toList(),
    );
  }
}
