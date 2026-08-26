import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import 'time_field_input.dart';

/// デスクトップ幅の日時フィールド。`HH:MM` のキー入力と5分刻みのステッパー、
/// 日付は1日ステッパーと月グリッドのカレンダー。
///
/// モバイルのホイールシートを流用しないのは、ポインタで回す前提の操作が
/// キーボードのある環境で最も遅い入力手段になるため。値域の保証は
/// [AppNotifier.applyPickedTime] が持っているので、ここでは解釈だけを担う。
class DesktopTimeField extends ConsumerStatefulWidget {
  const DesktopTimeField({super.key, required this.mode, required this.label});

  final PickerMode mode;
  final String label;

  @override
  ConsumerState<DesktopTimeField> createState() => _DesktopTimeFieldState();
}

class _DesktopTimeFieldState extends ConsumerState<DesktopTimeField> {
  late final TextEditingController _controller;
  late final FocusNode _focusNode;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: _current().format());
    _focusNode = FocusNode()..addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _focusNode.removeListener(_onFocusChanged);
    _focusNode.dispose();
    _controller.dispose();
    super.dispose();
  }

  TimeValue _current() {
    final state = ref.read(appStateProvider);
    return widget.mode == PickerMode.depart ? state.departure : state.arrival;
  }

  void _onFocusChanged() {
    if (_focusNode.hasFocus) {
      _controller.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _controller.text.length,
      );
      return;
    }
    _commitText();
  }

  void _commitText() {
    final parsed = parseTimeInput(_controller.text);
    // 数字が無い入力は「消しただけ」であって時刻の指定ではない。直前の値へ戻す。
    if (parsed == null) {
      _syncFromState();
      return;
    }
    _apply(h: parsed.h, m: parsed.m);
  }

  void _step(int deltaMinutes) {
    final current = _current();
    // 編集途中の表示値を基点にする。確定値から動かすと、10:00 と打った直後の
    // ↑ が 09:35 を返し、打ったばかりの値が黙って捨てられる。
    final typed = parseTimeInput(_controller.text);
    final base = typed == null ? current.totalMinutes : typed.h * 60 + typed.m;
    final stepped = stepTotalMinutes(base, deltaMinutes);
    final dateOffset = current.dateOffset + stepped.dayDelta;
    // 選べる範囲の外へは動かさない。時刻だけ折り返して日付を据え置くと、
    // 00:02 の5分前が「同日の 23:57」＝24時間近く後ろへ飛ぶ。上端を素通り
    // させると、日付ステッパーでは作れない 91 日目が時刻側から作れてしまう。
    if (dateOffset < 0 || dateOffset > kMaxDateOffsetDays) return;
    _apply(
      h: stepped.totalMinutes ~/ 60,
      m: stepped.totalMinutes % 60,
      dateOffset: dateOffset,
    );
  }

  void _stepDay(int deltaDays) {
    final current = _current();
    final dateOffset = current.dateOffset + deltaDays;
    if (dateOffset < 0 || dateOffset > kMaxDateOffsetDays) return;
    _apply(h: current.h, m: current.m, dateOffset: dateOffset);
  }

  /// `add(Duration(days:))` は夏時間を跨ぐと前日23時へ落ちる。成分から組む。
  DateTime _dateAt(DateTime now, int offset) =>
      DateTime(now.year, now.month, now.day + offset);

  /// カレンダーが出す最初の日。出発より前を選ばせると
  /// [AppNotifier.applyPickedTime] が戻すので、選んだ日と確定した日が食い違う。
  int _firstSelectableOffset() {
    if (widget.mode == PickerMode.depart) return 0;
    final departure = ref.read(appStateProvider).departure;
    // isNow でも実時刻でなく保持値で数える。applyPickedTime が比べるのは保持値
    // なので、下限だけ実時刻へ寄せると25時間の予算が黙って作れる（#264）。
    final offset = departure.isNow ? 0 : departure.dateOffset;
    final carry =
        (departure.totalMinutes + kMinBudgetMinutes) ~/ Duration.minutesPerDay;
    return offset + carry;
  }

  /// カレンダーが出す最後の日。押し出された到着は [kMaxDateOffsetDays] の外に
  /// 居ることがあり、定数で切るとその日が消えて開いて確定しただけで値が動く。
  int _lastSelectableOffset() {
    var last = kMaxDateOffsetDays;
    final floor = _firstSelectableOffset();
    if (floor > last) last = floor;
    final current = _current().dateOffset;
    if (current > last) last = current;
    return last;
  }

  /// 月グリッドのカレンダーを開く。ステッパーだけでは上限の90日目まで90回押す
  /// 必要があり、遠い日付を選ぶ手段が実質無い。範囲は [kMaxDateOffsetDays] から
  /// 引く——独自に決めるとホイールシートと作れる日付が食い違う。
  Future<void> _pickDate() async {
    final opened = ref.read(nowProvider)();
    final firstOffset = _firstSelectableOffset();
    final first = _dateAt(opened, firstOffset);
    final last = _dateAt(opened, _lastSelectableOffset());
    final initial = _dateAt(opened, _current().dateOffset);
    final picked = await showDatePicker(
      context: context,
      initialDate: initial.isBefore(first)
          ? first
          : (initial.isAfter(last) ? last : initial),
      firstDate: first,
      lastDate: last,
      // 既定の DateTime.now() だと、時計を差し替えたとき「今日」の強調がずれる。
      currentDate: _dateAt(opened, 0),
    );
    if (!mounted) return;
    final closed = ref.read(nowProvider)();
    // 確定値でなく編集途中の表示値を基点にする。再基準化より先に読むのは、
    // それが state を書き換えて欄へ跳ね返るため。
    final typed = parseTimeInput(_controller.text);
    final current = _current();
    // 片方だけ新しい今日で数え直すと相手が古い今日に取り残される。取り消しでも
    // 通すのは、基準日が動いたのが操作と無関係だから。
    ref
        .read(appStateProvider.notifier)
        .rebaseDates(calendarDaysBetween(from: opened, to: closed));
    // 選んだ日が表示中に過ぎたら丸めない。今日へ丸めると、開いた時点の 23:55 と
    // 組んで丸1日後になる。
    if (picked == null || calendarDaysBetween(from: closed, to: picked) < 0) {
      _syncFromState();
      return;
    }
    _apply(
      h: typed?.h ?? current.h,
      m: typed?.m ?? current.m,
      dateOffset: dateOffsetFrom(
        picked: picked,
        now: closed,
        maxOffset: _lastSelectableOffset(),
      ),
    );
  }

  void _apply({required int h, required int m, int? dateOffset}) {
    final offset = dateOffset ?? _current().dateOffset;
    var total = h * 60 + m;
    // 到着の下限は出発 + 最小ギャップで、applyPickedTime が持っている。
    // ここで見るのは出発の下限だけ。
    if (widget.mode == PickerMode.depart) {
      final now = ref.read(nowProvider)();
      total = clampDepartureMinutes(
        totalMinutes: total,
        dateOffset: offset,
        nowMinutes: now.hour * 60 + now.minute,
      );
    }
    ref
        .read(appStateProvider.notifier)
        .applyPickedTime(
          mode: widget.mode,
          h: total ~/ 60,
          m: total % 60,
          dateOffset: offset,
        );
    _syncFromState();
  }

  void _syncFromState() {
    final text = _current().format();
    if (_controller.text == text) return;
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final side = widget.mode == PickerMode.depart ? 'depart' : 'arrival';
    // 日付ラベルは state の変化で描き直す必要がある（出発の変更で到着が翌日へ
    // ずれる経路がある）。read ではなく watch で取る。
    final current = widget.mode == PickerMode.depart
        ? ref.watch(appStateProvider.select((s) => s.departure))
        : ref.watch(appStateProvider.select((s) => s.arrival));
    // 到着の自動シフト（出発を動かしたとき）を欄へ映す。編集中は手を入れない。
    ref.listen(appStateProvider, (_, _) {
      if (!_focusNode.hasFocus) _syncFromState();
    });
    final focused = _focusNode.hasFocus;
    // 日付ラベルとカレンダーの範囲は同じ時計から引く。既定の DateTime.now() を
    // 使うと、時計を差し替えたときにラベルだけ別の日を指す。
    final now = ref.read(nowProvider)();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          widget.label,
          style: jpStyle(
            size: 12.5,
            weight: FontWeight.w800,
            color: c.ink2,
            letterSpacing: 0.08 * 12.5,
          ),
        ),
        const SizedBox(height: 6),
        Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: focused ? c.paper : c.ivory,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: focused ? c.moss400 : c.hairline),
            boxShadow: focused
                ? [BoxShadow(color: c.moss50, blurRadius: 0, spreadRadius: 3)]
                : null,
          ),
          child: Row(
            children: [
              Expanded(
                child: Shortcuts(
                  // WidgetsApp が根に置く DefaultTextEditingShortcuts より
                  // 焦点に近いため、単一行での「行頭／行末へ移動」より先に効く。
                  shortcuts: const {
                    SingleActivator(LogicalKeyboardKey.arrowUp): _StepIntent(
                      kTimeStepMinutes,
                    ),
                    SingleActivator(LogicalKeyboardKey.arrowDown): _StepIntent(
                      -kTimeStepMinutes,
                    ),
                  },
                  child: Actions(
                    actions: {
                      _StepIntent: CallbackAction<_StepIntent>(
                        onInvoke: (intent) {
                          _step(intent.deltaMinutes);
                          return null;
                        },
                      ),
                    },
                    child: TextField(
                      key: Key('desktop-time-input-$side'),
                      controller: _controller,
                      focusNode: _focusNode,
                      keyboardType: TextInputType.datetime,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) {
                        _commitText();
                        _focusNode.unfocus();
                      },
                      style: numStyle(size: 21, color: c.ink),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        isCollapsed: true,
                      ),
                    ),
                  ),
                ),
              ),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _StepButton(
                    key: Key('desktop-time-step-up-$side'),
                    icon: Icons.keyboard_arrow_up,
                    semanticLabel: l10n.timeFieldLater(widget.label),
                    onTap: () => _step(kTimeStepMinutes),
                  ),
                  const SizedBox(height: 4),
                  _StepButton(
                    key: Key('desktop-time-step-down-$side'),
                    icon: Icons.keyboard_arrow_down,
                    semanticLabel: l10n.timeFieldEarlier(widget.label),
                    onTap: () => _step(-kTimeStepMinutes),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        // 日付は時刻と同じ入力面に無いと、デスクトップでは明日以降を選ぶ手段が
        // まるごと無くなる（ホイールシートを出さないため）。
        Row(
          children: [
            _StepButton(
              key: Key('desktop-date-step-down-$side'),
              icon: Icons.chevron_left,
              semanticLabel: l10n.timeFieldPreviousDay,
              onTap: () => _stepDay(-1),
            ),
            Expanded(
              child: Semantics(
                button: true,
                label: l10n.timeFieldOpenCalendar(widget.label),
                child: InkWell(
                  key: Key('desktop-date-open-$side'),
                  onTap: _pickDate,
                  borderRadius: BorderRadius.circular(7),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Text(
                      current.dateLabel(now: now) ?? l10n.homeToday,
                      key: Key('desktop-date-label-$side'),
                      textAlign: TextAlign.center,
                      style:
                          jpStyle(
                            size: 12,
                            weight: FontWeight.w700,
                            color: current.dateOffset == 0 ? c.ink3 : c.moss700,
                          ).copyWith(
                            decoration: TextDecoration.underline,
                            decorationColor: c.hairline,
                          ),
                    ),
                  ),
                ),
              ),
            ),
            _StepButton(
              key: Key('desktop-date-step-up-$side'),
              icon: Icons.chevron_right,
              semanticLabel: l10n.timeFieldNextDay,
              onTap: () => _stepDay(1),
            ),
          ],
        ),
      ],
    );
  }
}

class _StepIntent extends Intent {
  const _StepIntent(this.deltaMinutes);
  final int deltaMinutes;
}

class _StepButton extends StatelessWidget {
  const _StepButton({
    super.key,
    required this.icon,
    required this.semanticLabel,
    required this.onTap,
  });

  final IconData icon;
  final String semanticLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    // 受け取ったラベルを Semantics へ渡さないと、読み上げでは向きの無い
    // 矢印がただ並ぶ。「前の日へ」と「次の日へ」が区別できなくなる。
    return Semantics(
      button: true,
      label: semanticLabel,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(7),
        child: Container(
          width: 26,
          height: 22,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: c.hairline),
          ),
          child: Icon(icon, size: 14, color: c.ink2),
        ),
      ),
    );
  }
}
