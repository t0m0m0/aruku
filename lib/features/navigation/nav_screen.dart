import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_map.dart';

class NavScreen extends ConsumerWidget {
  const NavScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);

    return Material(
      color: c.mapBg,
      child: Stack(
        children: [
          // Full-bleed map
          const Positioned.fill(
            child: ArukuMap(variant: ArukuMapVariant.nav),
          ),

          SafeArea(
            child: Column(
              children: [
                // Top instruction card
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                  child: _InstructionCard(
                    onClose: () => notifier.go(Screen.home),
                  ),
                ),
                const Spacer(),
                // Bottom stats bar
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                  child: _StatsBar(),
                ),
              ],
            ),
          ),

          // Right controls
          Positioned(
            right: 12,
            top: 220,
            child: Column(
              children: [
                _NavChip(icon: Ic.layers(size: 20, color: context.c.ink2)),
                const SizedBox(height: 8),
                _NavChip(icon: Ic.compass(size: 20, color: context.c.ink2)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NavChip extends StatelessWidget {
  const _NavChip({required this.icon});
  final Widget icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: const Color(0xE6FFFDF3),
        borderRadius: BorderRadius.circular(14),
        boxShadow: const [
          BoxShadow(
              color: Color(0x1F000000),
              blurRadius: 8,
              offset: Offset(0, 2)),
        ],
      ),
      child: Center(child: icon),
    );
  }
}

class _InstructionCard extends StatelessWidget {
  const _InstructionCard({required this.onClose});
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          decoration: BoxDecoration(
            color: c.moss700,
            borderRadius: BorderRadius.circular(22),
            boxShadow: const [
              BoxShadow(
                  color: Color(0x4D22361E),
                  blurRadius: 30,
                  offset: Offset(0, 12)),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: const Color(0x24FFFFFF),
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Center(child: Ic.arrowUp(size: 32, color: c.ivory)),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text('200',
                            style: numStyle(
                                size: 32,
                                weight: FontWeight.w500,
                                color: c.ivory)),
                        const SizedBox(width: 6),
                        Text('m 直進',
                            style: jpStyle(
                                size: 14,
                                weight: FontWeight.w700,
                                color: c.ivory)),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text('そのあと右折 · 表参道方面',
                        style: jpStyle(
                            size: 13,
                            weight: FontWeight.w500,
                            color: c.ivory.withValues(alpha: 0.78))),
                  ],
                ),
              ),
              InkWell(
                onTap: onClose,
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: const Color(0x24FFFFFF),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Center(child: Ic.close(size: 18, color: c.ivory)),
                ),
              ),
            ],
          ),
        ),
        // Next-next preview
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 12),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: const BoxDecoration(
            color: Color(0xC722361E),
            borderRadius: BorderRadius.vertical(bottom: Radius.circular(14)),
          ),
          child: Row(
            children: [
              Ic.chevron(size: 14, color: const Color(0xD9FFFFFF), dir: ChevronDir.right),
              const SizedBox(width: 8),
              Text('1.2 km',
                  style: numStyle(
                      size: 12,
                      weight: FontWeight.w500,
                      color: const Color(0xD9FFFFFF))),
              const SizedBox(width: 4),
              Text(' 先 · 渋谷川沿いを左へ',
                  style: jpStyle(
                      size: 12,
                      weight: FontWeight.w600,
                      color: const Color(0xD9FFFFFF))),
            ],
          ),
        ),
      ],
    );
  }
}

class _StatsBar extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      decoration: BoxDecoration(
        color: c.paper,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: c.hairline),
        boxShadow: const [
          BoxShadow(
              color: Color(0x2E000000),
              blurRadius: 40,
              offset: Offset(0, 16)),
        ],
      ),
      child: Column(
        children: [
          // Progress
          Row(
            children: [
              Text('2.1 / 6.2 km',
                  style: numStyle(
                      size: 11, weight: FontWeight.w700, color: c.moss700)),
              const SizedBox(width: 10),
              Expanded(
                child: SizedBox(
                  height: 6,
                  child: Stack(
                    children: [
                      Positioned.fill(
                        child: Container(
                          decoration: BoxDecoration(
                            color: c.moss100,
                            borderRadius: BorderRadius.circular(999),
                          ),
                        ),
                      ),
                      FractionallySizedBox(
                        widthFactor: 0.34,
                        child: Container(
                          decoration: BoxDecoration(
                            gradient: LinearGradient(
                              colors: [c.moss400, c.moss600],
                            ),
                            borderRadius: BorderRadius.circular(999),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text('34%',
                  style: numStyle(
                      size: 11, weight: FontWeight.w700, color: c.ink3)),
            ],
          ),
          const SizedBox(height: 12),
          IntrinsicHeight(
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('到着',
                          style: jpStyle(
                              size: 10,
                              weight: FontWeight.w700,
                              color: c.ink3,
                              letterSpacing: 0.06 * 10)),
                      Text('09:42',
                          style: numStyle(
                              size: 28,
                              weight: FontWeight.w500,
                              color: c.ink)),
                    ],
                  ),
                ),
                _Sep(),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('残り',
                            style: jpStyle(
                                size: 10,
                                weight: FontWeight.w700,
                                color: c.ink3,
                                letterSpacing: 0.06 * 10)),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Text('4.1',
                                style: numStyle(
                                    size: 28,
                                    weight: FontWeight.w500,
                                    color: c.ink)),
                            const SizedBox(width: 4),
                            Text('km',
                                style: jpStyle(
                                    size: 12,
                                    weight: FontWeight.w700,
                                    color: c.ink2)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                _Sep(),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('消費',
                            style: jpStyle(
                                size: 10,
                                weight: FontWeight.w700,
                                color: c.burnt,
                                letterSpacing: 0.06 * 10)),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Text('97',
                                style: numStyle(
                                    size: 28,
                                    weight: FontWeight.w500,
                                    color: c.burnt)),
                            const SizedBox(width: 4),
                            Text('kcal',
                                style: jpStyle(
                                    size: 12,
                                    weight: FontWeight.w700,
                                    color: c.burnt)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Container(
            width: double.infinity,
            height: 48,
            decoration: BoxDecoration(
              color: c.moss100,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Ic.pause(size: 16, color: c.moss700),
                const SizedBox(width: 8),
                Text('一時停止 · 寄り道',
                    style: jpStyle(
                        size: 14,
                        weight: FontWeight.w800,
                        color: c.moss700,
                        letterSpacing: 0.06 * 14)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Sep extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(width: 1, color: c.hairline);
  }
}
