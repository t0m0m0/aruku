import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';

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
  late final DateTime _arrivalMin;
  late PickerMode _mode;
  late DateTime _selected;

  /// 「現在時刻」ボタンなどでホイールを差し替えるたびに増やし、
  /// CupertinoDatePicker の key を変えて initialDateTime を反映させる。
  int _pickerEpoch = 0;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _today = DateTime(now.year, now.month, now.day);
    // 過去時刻は選択不可。秒は落として分単位の下限にする（1分刻みで選べる）。
    _minDate = DateTime(now.year, now.month, now.day, now.hour, now.minute);
    _maxDate = DateTime(_today.year, _today.month, _today.day + 90, 23, 59);
    _arrivalMin = _computeArrivalMin();
    _mode = widget.initialMode;
    _selected = _initialFor(_mode);
  }

  /// 到着タブのホイール下限を算出する。「出発 < 到着」を保つため出発+最小ギャップを
  /// 下限にして、出発より前を選べなくする。出発はモーダル表示中に変わらないため
  /// initState で一度だけ呼び、build ごとの ref.read を避ける。
  DateTime _computeArrivalMin() {
    final dep = ref.read(appStateProvider).departure;
    final depDt = dep.isNow
        ? _minDate
        : DateTime(
            _today.year,
            _today.month,
            _today.day + dep.dateOffset,
            dep.h,
            dep.m,
          );
    final floor = depDt.add(const Duration(minutes: kMinBudgetMinutes));
    final lower = floor.isAfter(_minDate) ? floor : _minDate;
    return lower.isAfter(_maxDate) ? _maxDate : lower;
  }

  /// ホイールの下限。到着タブはキャッシュした出発基準、出発タブは現在時刻が下限。
  DateTime _minFor(PickerMode mode) =>
      mode == PickerMode.arrival ? _arrivalMin : _minDate;

  DateTime _initialFor(PickerMode mode) {
    final min = _minFor(mode);
    final state = ref.read(appStateProvider);
    final t = mode == PickerMode.depart ? state.departure : state.arrival;
    // isNow は記憶した丸め値ではなく、開いた時点の現在時刻（分単位）に合わせる。
    if (t.isNow) return min;
    final dt = DateTime(
      _today.year,
      _today.month,
      _today.day + t.dateOffset,
      t.h,
      t.m,
    );
    if (dt.isBefore(min)) return min;
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

  /// 日付ピッカーのホイールを現在時刻（分単位）へ合わせる。出発タブ専用。
  /// シートは閉じず、確定はユーザーの「完了」に委ねる。
  void _setNow() {
    final now = DateTime.now();
    final nowMinute = DateTime(
      now.year,
      now.month,
      now.day,
      now.hour,
      now.minute,
    );
    setState(() {
      _selected = nowMinute.isBefore(_minDate) ? _minDate : nowMinute;
      _pickerEpoch++;
    });
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
                key: ValueKey('${_mode}_$_pickerEpoch'),
                mode: CupertinoDatePickerMode.dateAndTime,
                use24hFormat: true,
                minimumDate: _minFor(_mode),
                maximumDate: _maxDate,
                initialDateTime: _selected,
                onDateTimeChanged: (d) => _selected = d,
              ),
            ),
            if (_mode == PickerMode.depart)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 8, 18, 0),
                child: Align(
                  alignment: Alignment.center,
                  child: _NowButton(
                    key: const Key('picker_now'),
                    onTap: _setNow,
                  ),
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

/// 出発を現在時刻に戻すための控えめなピル型ボタン。
class _NowButton extends StatelessWidget {
  const _NowButton({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.moss50,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Ic.clock(size: 13, color: c.moss700),
              const SizedBox(width: 6),
              Text(
                '現在時刻',
                style: jpStyle(
                  size: 13,
                  weight: FontWeight.w800,
                  color: c.moss700,
                ),
              ),
            ],
          ),
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
