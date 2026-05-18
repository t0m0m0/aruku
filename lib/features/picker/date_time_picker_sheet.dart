import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';

/// 日付＋時刻を1つのホイールで選ぶ Cupertino 風シートを開く。
/// [initialMode] は最初に選択される出発/到着タブ。
Future<void> showDateTimePickerSheet(
  BuildContext context, {
  required PickerMode initialMode,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (_) => _DateTimePickerSheet(initialMode: initialMode),
  );
}

class _DateTimePickerSheet extends ConsumerStatefulWidget {
  const _DateTimePickerSheet({required this.initialMode});

  final PickerMode initialMode;

  @override
  ConsumerState<_DateTimePickerSheet> createState() =>
      _DateTimePickerSheetState();
}

class _DateTimePickerSheetState extends ConsumerState<_DateTimePickerSheet> {
  late final DateTime _today;
  late final DateTime _minDate;
  late final DateTime _maxDate;
  late PickerMode _mode;
  late DateTime _selected;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _today = DateTime(now.year, now.month, now.day);
    _minDate = _today;
    _maxDate = DateTime(_today.year, _today.month, _today.day + 90, 23, 59);
    _mode = widget.initialMode;
    _selected = _initialFor(_mode);
  }

  DateTime _initialFor(PickerMode mode) {
    final state = ref.read(appStateProvider);
    final t = mode == PickerMode.depart ? state.departure : state.arrival;
    final offsetDays = t.isNow ? 0 : t.dateOffset;
    final dt = DateTime(
      _today.year,
      _today.month,
      _today.day + offsetDays,
      t.h,
      t.m,
    );
    if (dt.isBefore(_minDate)) return _minDate;
    if (dt.isAfter(_maxDate)) return _maxDate;
    return dt;
  }

  void _confirm() {
    final dateOnly = DateTime(_selected.year, _selected.month, _selected.day);
    final dateOffset = dateOnly.difference(_today).inDays;
    ref
        .read(appStateProvider.notifier)
        .applyPickedTime(
          mode: _mode,
          h: _selected.hour,
          m: _selected.minute,
          dateOffset: dateOffset < 0 ? 0 : dateOffset,
        );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.paper,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 10, bottom: 6),
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: c.ink4,
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
              child: SizedBox(
                width: double.infinity,
                child: CupertinoSlidingSegmentedControl<PickerMode>(
                  groupValue: _mode,
                  backgroundColor: c.moss50,
                  thumbColor: c.paper,
                  children: {
                    PickerMode.depart: _segLabel(
                      'seg_depart',
                      '出発',
                      _mode == PickerMode.depart,
                    ),
                    PickerMode.arrival: _segLabel(
                      'seg_arrival',
                      '到着',
                      _mode == PickerMode.arrival,
                    ),
                  },
                  onValueChanged: (v) {
                    if (v == null) return;
                    setState(() {
                      _mode = v;
                      _selected = _initialFor(v);
                    });
                  },
                ),
              ),
            ),
            SizedBox(
              height: 216,
              child: CupertinoDatePicker(
                key: ValueKey(_mode),
                mode: CupertinoDatePickerMode.dateAndTime,
                use24hFormat: true,
                minimumDate: _minDate,
                maximumDate: _maxDate,
                initialDateTime: _selected,
                onDateTimeChanged: (d) => _selected = d,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 8),
              child: Row(
                children: [
                  Expanded(
                    child: _SheetButton(
                      key: const Key('picker_cancel'),
                      label: 'キャンセル',
                      filled: false,
                      onTap: () => Navigator.of(context).pop(),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _SheetButton(
                      key: const Key('picker_done'),
                      label: '完了',
                      filled: true,
                      onTap: _confirm,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _segLabel(String keyValue, String text, bool active) {
    final c = context.c;
    return Padding(
      key: Key(keyValue),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Text(
        text,
        style: jpStyle(
          size: 14,
          weight: FontWeight.w800,
          color: active ? c.moss700 : c.ink2,
        ),
      ),
    );
  }
}

class _SheetButton extends StatelessWidget {
  const _SheetButton({
    super.key,
    required this.label,
    required this.filled,
    required this.onTap,
  });

  final String label;
  final bool filled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: filled ? c.moss600 : c.ivory,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Ink(
          height: 52,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: filled ? null : Border.all(color: c.hairline),
          ),
          child: Center(
            child: Text(
              label,
              style: jpStyle(
                size: 16,
                weight: FontWeight.w800,
                color: filled ? c.ivory : c.ink2,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
