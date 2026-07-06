import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/services/route_service.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_map.dart';

class LoadingScreen extends ConsumerStatefulWidget {
  const LoadingScreen({super.key});

  @override
  ConsumerState<LoadingScreen> createState() => _LoadingScreenState();
}

class _LoadingScreenState extends ConsumerState<LoadingScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulse;
  late final AnimationController _bob;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    );
    _bob = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _pulse.repeat();
      _bob.repeat(reverse: true);
    });
  }

  @override
  void dispose() {
    _pulse.dispose();
    _bob.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(appStateProvider);
    final budget = TimeValue.formatBudgetJp(state.budgetMinutes);
    final dest = state.destination;
    final subtitle = dest != null && dest.isNotEmpty
        ? l10n.loadingDestinationBudget(dest, budget)
        : l10n.loadingBudgetOnly(budget);
    final phaseIndex = switch (state.routePhase) {
      RoutePhase.routing => 0,
      RoutePhase.walkability => 1,
      RoutePhase.building => 2,
      null => 0,
    };
    return Material(
      color: c.ivory,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Dimmed map background (decorative — exclude from semantics)
          const Opacity(
            opacity: 0.35,
            child: ColorFiltered(
              colorFilter: ColorFilter.matrix([
                0.7, 0.21, 0.07, 0, 0, //
                0.07, 0.86, 0.07, 0, 0, //
                0.07, 0.21, 0.72, 0, 0, //
                0, 0, 0, 1, 0,
              ]),
              child: ArukuMap(showRoute: false),
            ),
          ),
          // Radial fade veil
          IgnorePointer(
            child: Container(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment.center,
                  radius: 0.7,
                  colors: [Colors.transparent, c.ivory],
                ),
              ),
            ),
          ),

          // Center stack
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 200,
                  height: 200,
                  child: Stack(
                    alignment: Alignment.center,
                    children: [
                      // Pulse rings (decorative)
                      Stack(
                        alignment: Alignment.center,
                        children: [
                          for (int i = 1; i <= 3; i++)
                            AnimatedBuilder(
                              animation: _pulse,
                              builder: (_, _) {
                                final phase = ((_pulse.value + i * 0.16) % 1.0);
                                final scale = 0.6 + phase * 0.6;
                                final opacity = (1 - phase) * (0.45 / i);
                                return Transform.scale(
                                  scale: scale,
                                  child: Opacity(
                                    opacity: opacity.clamp(0.0, 1.0),
                                    child: Container(
                                      width: 60.0 + i * 50,
                                      height: 60.0 + i * 50,
                                      decoration: BoxDecoration(
                                        shape: BoxShape.circle,
                                        border: Border.all(
                                          color: c.moss300,
                                          width: 2,
                                        ),
                                      ),
                                    ),
                                  ),
                                );
                              },
                            ),
                        ],
                      ),
                      AnimatedBuilder(
                        animation: _bob,
                        builder: (_, _) {
                          return Transform.translate(
                            offset: Offset(0, -6 * _bob.value),
                            child: Container(
                              width: 96,
                              height: 96,
                              decoration: BoxDecoration(
                                color: c.moss500,
                                borderRadius: BorderRadius.circular(32),
                                boxShadow: const [
                                  BoxShadow(
                                    color: ArukuTokens.shadowGlow,
                                    blurRadius: 40,
                                    offset: Offset(0, 16),
                                  ),
                                ],
                              ),
                              child: Center(
                                child: Ic.walk(size: 48, color: c.ivory),
                              ),
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 28),
                Text(
                  l10n.loadingSearchingMessage,
                  style: jpStyle(
                    size: 22,
                    weight: FontWeight.w800,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  subtitle,
                  style: jpStyle(
                    size: 13,
                    weight: FontWeight.w500,
                    color: c.ink3,
                  ),
                ),
                const SizedBox(height: 32),
                _ProgressBar(phaseIndex: phaseIndex),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 実態（3フェーズ）から切り離した、常に前進し続ける擬似プログレスバー。
///
/// 時間ベースの漸近ランプ `_asymptote·(1−e^(−t/τ))` が毎フレームわずかに
/// 前進するため、フェーズ境界でも止まって見えない。フェーズ到達は floor
/// （下限）として `target = max(ramp, floor)` に合成し、value を指数追従で
/// 引き上げるので、floor が跳ねても段差にならず「加速」に見える。
class _ProgressBar extends StatefulWidget {
  const _ProgressBar({required this.phaseIndex});

  final int phaseIndex;

  @override
  State<_ProgressBar> createState() => _ProgressBarState();
}

class _ProgressBarState extends State<_ProgressBar>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  Duration _last = Duration.zero;
  double _value = 0;

  /// フェーズ到達で保証する塗り率の下限（routing / walkability / building）。
  static const _floors = [0.0, 0.55, 0.95];

  /// 時間ランプの漸近上限。完了（画面遷移）まで満タンにはしない。
  static const _asymptote = 0.9;

  /// 時間ランプの時定数（秒）。小さいほど序盤が速い。
  static const _rampTau = 6.0;

  /// 指数追従の時定数（ミリ秒）。value が target に寄る速さ。
  static const _chaseTau = 250.0;

  double get _floor => _floors[widget.phaseIndex.clamp(0, _floors.length - 1)];

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_onTick)..start();
  }

  void _onTick(Duration elapsed) {
    final dtMs = (elapsed - _last).inMicroseconds / 1000.0;
    _last = elapsed;
    final tSec = elapsed.inMicroseconds / 1e6;
    final ramp = _asymptote * (1 - math.exp(-tSec / _rampTau));
    final target = math.max(ramp, _floor);
    final k = 1 - math.exp(-dtMs / _chaseTau);
    setState(() => _value += (target - _value) * k);
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return SizedBox(
      width: 220,
      height: 6,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: Stack(
          children: [
            // Track
            Positioned.fill(
              child: ColoredBox(color: c.ink4.withValues(alpha: 0.35)),
            ),
            // Fill
            Positioned.fill(
              child: FractionallySizedBox(
                key: const ValueKey('loading-progress-fill'),
                alignment: Alignment.centerLeft,
                widthFactor: _value.clamp(0.0, 1.0),
                heightFactor: 1,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: c.moss500,
                    borderRadius: BorderRadius.circular(3),
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
