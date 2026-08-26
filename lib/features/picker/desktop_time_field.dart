import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import 'time_field_input.dart';

/// デスクトップ幅の時刻フィールド。`HH:MM` のキー入力と5分刻みのステッパー。
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
    final stepped = stepTotalMinutes(current.totalMinutes, deltaMinutes);
    final dateOffset = current.dateOffset + stepped.dayDelta;
    // 今日より前へは動かさない。時刻だけ折り返して日付を据え置くと、
    // 00:02 の5分前が「同日の 23:57」＝24時間近く後ろへ飛ぶ。
    if (dateOffset < 0) return;
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

  void _apply({required int h, required int m, int? dateOffset}) {
    ref
        .read(appStateProvider.notifier)
        .applyPickedTime(
          mode: widget.mode,
          h: h,
          m: m,
          dateOffset: dateOffset ?? _current().dateOffset,
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
                    semanticLabel: widget.label,
                    onTap: () => _step(kTimeStepMinutes),
                  ),
                  const SizedBox(height: 4),
                  _StepButton(
                    key: Key('desktop-time-step-down-$side'),
                    icon: Icons.keyboard_arrow_down,
                    semanticLabel: widget.label,
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
              child: Text(
                current.dateLabel() ?? l10n.homeToday,
                key: Key('desktop-date-label-$side'),
                textAlign: TextAlign.center,
                style: jpStyle(
                  size: 12,
                  weight: FontWeight.w700,
                  color: current.dateOffset == 0 ? c.ink3 : c.moss700,
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
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 26,
        height: 22,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(7),
          border: Border.all(color: c.hairline),
        ),
        child: Icon(icon, size: 14, color: c.ink2),
      ),
    );
  }
}
