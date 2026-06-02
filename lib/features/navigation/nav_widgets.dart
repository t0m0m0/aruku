part of 'nav_screen.dart';

class _NavChip extends StatelessWidget {
  const _NavChip({super.key, required this.icon, this.onTap});
  final Widget icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: ArukuColors.navChipSurface,
      borderRadius: BorderRadius.circular(14),
      elevation: 2,
      shadowColor: ArukuColors.shadowChip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: SizedBox(width: 44, height: 44, child: Center(child: icon)),
      ),
    );
  }
}

class _InstructionCard extends StatelessWidget {
  const _InstructionCard({this.guidance, this.destination});
  final NavGuidance? guidance;
  final String? destination;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final g = guidance;
    final hasNext = g?.nextManeuver != null;
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          decoration: BoxDecoration(
            color: c.moss700,
            borderRadius: BorderRadius.circular(22),
            boxShadow: const [
              BoxShadow(
                color: ArukuColors.shadowFloating,
                blurRadius: 30,
                offset: Offset(0, 12),
              ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: ArukuColors.glassWhite,
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
                        Text(
                          g != null ? '${g.distanceToNextTurnM}' : '--',
                          style: numStyle(
                            size: 32,
                            weight: FontWeight.w500,
                            color: c.ivory,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          'm ${g?.currentManeuver.label ?? '直進'}',
                          style: jpStyle(
                            size: 14,
                            weight: FontWeight.w700,
                            color: c.ivory,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      destination != null ? '$destination まで' : '--',
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w500,
                        color: c.ivory.withValues(alpha: 0.78),
                      ),
                    ),
                  ],
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
            color: ArukuColors.navPreviewSurface,
            borderRadius: BorderRadius.vertical(bottom: Radius.circular(14)),
          ),
          child: Row(
            children: [
              Ic.chevron(
                size: 14,
                color: ArukuColors.onMossStrong,
                dir: ChevronDir.right,
              ),
              const SizedBox(width: 8),
              Text(
                hasNext ? '${g!.distanceToNextTurnNextM}m' : '--',
                style: numStyle(
                  size: 12,
                  weight: FontWeight.w500,
                  color: ArukuColors.onMossStrong,
                ),
              ),
              const SizedBox(width: 4),
              Text(
                g?.nextManeuver?.label ?? '--',
                style: jpStyle(
                  size: 12,
                  weight: FontWeight.w600,
                  color: ArukuColors.onMossStrong,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// オフルートからの自動再検索中に表示する軽量バナー。
class _RerouteBanner extends StatelessWidget {
  const _RerouteBanner();

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuCard(
      borderRadius: 14,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2, color: c.moss600),
          ),
          const SizedBox(width: 10),
          Text(
            'ルートを再検索中…',
            style: jpStyle(size: 13, weight: FontWeight.w700, color: c.moss700),
          ),
        ],
      ),
    );
  }
}

class _StatsBar extends StatelessWidget {
  const _StatsBar({
    required this.traveledKm,
    required this.totalKm,
    required this.progress,
    required this.remainingKm,
    required this.arrivalTime,
    required this.consumedKcal,
    required this.onExit,
  });

  final double traveledKm;
  final double totalKm;
  final double progress;
  final double remainingKm;
  final String arrivalTime;
  final int consumedKcal;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuCard(
      borderRadius: 22,
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      shadow: const [
        BoxShadow(
          color: ArukuColors.shadowSheet,
          blurRadius: 40,
          offset: Offset(0, 16),
        ),
      ],
      child: Column(
        children: [
          // Progress
          Row(
            children: [
              Text(
                '${traveledKm.toStringAsFixed(1)} / '
                '${totalKm.toStringAsFixed(1)} km',
                style: numStyle(
                  size: 11,
                  weight: FontWeight.w700,
                  color: c.moss700,
                ),
              ),
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
                        widthFactor: progress.clamp(0.0, 1.0),
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
              Text(
                '${(progress * 100).round()}%',
                style: numStyle(
                  size: 11,
                  weight: FontWeight.w700,
                  color: c.ink3,
                ),
              ),
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
                      Text(
                        '到着',
                        style: jpStyle(
                          size: 10,
                          weight: FontWeight.w700,
                          color: c.ink3,
                          letterSpacing: 0.06 * 10,
                        ),
                      ),
                      Text(
                        arrivalTime,
                        style: numStyle(
                          size: 28,
                          weight: FontWeight.w500,
                          color: c.ink,
                        ),
                      ),
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
                        Text(
                          '残り',
                          style: jpStyle(
                            size: 10,
                            weight: FontWeight.w700,
                            color: c.ink3,
                            letterSpacing: 0.06 * 10,
                          ),
                        ),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Text(
                              remainingKm.toStringAsFixed(1),
                              style: numStyle(
                                size: 28,
                                weight: FontWeight.w500,
                                color: c.ink,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              'km',
                              style: jpStyle(
                                size: 12,
                                weight: FontWeight.w700,
                                color: c.ink2,
                              ),
                            ),
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
                        Text(
                          '消費',
                          style: jpStyle(
                            size: 10,
                            weight: FontWeight.w700,
                            color: c.burnt,
                            letterSpacing: 0.06 * 10,
                          ),
                        ),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Text(
                              '$consumedKcal',
                              style: numStyle(
                                size: 28,
                                weight: FontWeight.w500,
                                color: c.burnt,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              'kcal',
                              style: jpStyle(
                                size: 12,
                                weight: FontWeight.w700,
                                color: c.burnt,
                              ),
                            ),
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
          ArukuButton(
            key: const Key('nav-exit-button'),
            label: '終了',
            onPressed: onExit,
            icon: Ic.close(size: 16, color: c.danger),
            iconGap: 8,
            backgroundColor: c.dangerSoft,
            height: 48,
            textStyle: jpStyle(
              size: 14,
              weight: FontWeight.w800,
              color: c.danger,
              letterSpacing: 0.06 * 14,
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
