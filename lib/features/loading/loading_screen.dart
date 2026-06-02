import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/time_value.dart';
import '../../core/services/route_service.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
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
    final state = ref.watch(appStateProvider);
    final budget = TimeValue.formatBudgetJp(state.budgetMinutes);
    final dest = state.destination;
    final subtitle = dest != null && dest.isNotEmpty
        ? '$dest まで · 制限 $budget'
        : '制限 $budget';
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
          Opacity(
            opacity: 0.35,
            child: ColorFiltered(
              colorFilter: const ColorFilter.matrix([
                0.7, 0.21, 0.07, 0, 0, //
                0.07, 0.86, 0.07, 0, 0, //
                0.07, 0.21, 0.72, 0, 0, //
                0, 0, 0, 1, 0,
              ]),
              child: const ArukuMap(showRoute: false),
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
                  '歩ける道を、探しています',
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
                _ProgressSteps(phaseIndex: phaseIndex),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ProgressSteps extends StatelessWidget {
  const _ProgressSteps({required this.phaseIndex});

  final int phaseIndex;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    const labels = ['ルート計算', '徒歩判定', '結果生成'];
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (int i = 0; i < labels.length; i++) ...[
          Container(
            key: ValueKey('loading-step-$i-${i <= phaseIndex ? 'on' : 'off'}'),
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: i <= phaseIndex ? c.moss500 : c.ink4,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            labels[i],
            style: jpStyle(
              size: 11,
              weight: FontWeight.w700,
              color: i <= phaseIndex ? c.moss600 : c.ink3,
            ),
          ),
          if (i < labels.length - 1) ...[
            const SizedBox(width: 8),
            Container(width: 8, height: 1, color: c.ink4),
            const SizedBox(width: 8),
          ],
        ],
      ],
    );
  }
}
