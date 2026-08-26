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

  /// [now] から [offset] 日後の日付。`add(Duration(days:))` を使わないのは、
  /// 夏時間の切り替わりを跨ぐと1日が23時間になり、加算結果が前日の23時へ落ちる
  /// ため。日付として解釈される値は必ずカレンダー成分から組む。
  DateTime _dateAt(DateTime now, int offset) =>
      DateTime(now.year, now.month, now.day + offset);

  /// カレンダーが出す最初の日。
  ///
  /// 到着は出発より前へ置けない。選ばせておいて [AppNotifier.applyPickedTime] が
  /// 出発+最小ギャップへ戻すと、選んだ日と確定した日が食い違う。時刻の下限は
  /// 向こうの担当のままで、ここが決めるのは日付の下限だけ。
  int _firstSelectableOffset() {
    if (widget.mode == PickerMode.depart) return 0;
    final departure = ref.read(appStateProvider).departure;
    // isNow でも現在時刻ではなく保持値で数える。下限を実時刻へ寄せると、欄が
    // 09:30 を出したまま到着だけ翌日から始まり、[AppNotifier.applyPickedTime]
    // が比べるのは保持値のままなので25時間の予算が黙って作れる。isNow の
    // 古びは startSearch の再取得が引き受けている（#264）。
    final offset = departure.isNow ? 0 : departure.dateOffset;
    // 23:59 発の最小ギャップは翌日へ入る。日跨ぎを分で数えるのは、時刻を
    // DateTime へ起こすと再び夏時間の加算に触れるため。
    final carry =
        (departure.totalMinutes + kMinBudgetMinutes) ~/ Duration.minutesPerDay;
    return offset + carry;
  }

  /// 月グリッドのカレンダーを開き、選ばれた日を日付オフセットへ移す。
  ///
  /// ステッパーだけでは上限の90日目まで90回押す必要があり、遠い日付を選ぶ手段が
  /// 実質無い。範囲は [kMaxDateOffsetDays] から引く——ここを独自に決めると
  /// ホイールシートとデスクトップで作れる日付が食い違う。
  /// カレンダーが出す最後の日。
  ///
  /// 到着は出発+最小ギャップへ押し出されるため、[kMaxDateOffsetDays] を越えた
  /// 日に居ることがある。上限を定数で切るとその日がカレンダーから消え、開いて
  /// 確定しただけで値が動く。下限だけでなく今の値も含めて広げるのは、下限が
  /// 範囲内でも到着だけが外に出る組み合わせ（90日目 23:30 発→91日目 00:30 着）
  /// があるため。それ以上先は出発側が作れない。
  int _lastSelectableOffset() {
    var last = kMaxDateOffsetDays;
    final floor = _firstSelectableOffset();
    if (floor > last) last = floor;
    final current = _current().dateOffset;
    if (current > last) last = current;
    return last;
  }

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
      // 既定は DateTime.now() で、テストが時計を差し替えても実時刻を指す。
      // 「今日」の強調が firstDate と別の日に付く。
      currentDate: _dateAt(opened, 0),
    );
    if (picked == null || !mounted) return;
    final closed = ref.read(nowProvider)();
    // 編集途中の表示値を基点にする。確定値の時刻を持ち回ると、18:20 と打った
    // 直後に日付を変えたとき、打ったばかりの時刻が黙って捨てられる。
    //
    // 再基準化より先に読むのは、それが state を書き換えて欄へ跳ね返るため。
    // 確定するのはユーザーが見ていた値であって、揃え直した後の値ではない。
    final typed = parseTimeInput(_controller.text);
    final current = _current();
    // 表示中に日を跨ぐと、確定する側だけ新しい今日で数え直され、相手側は古い
    // 今日を基準にした値のまま残る。先に両方を同じ基準へ揃える。
    ref
        .read(appStateProvider.notifier)
        .rebaseDates(dateOffsetFrom(picked: closed, now: opened));
    // 選んだ日そのものが表示中に過ぎることがある（15日を出したまま16日に確定）。
    // 過去は表現できないので日は今日へ丸められ、開いた時点の 23:55 と組むと
    // 確定した覚えのない丸1日後になる。再基準化が置いた値をそのまま残す。
    if (_dateAt(picked, 0).isBefore(_dateAt(closed, 0))) {
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
