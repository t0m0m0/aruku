part of 'onboarding_screen.dart';

class _Eyebrow extends StatelessWidget {
  const _Eyebrow(this.text, {required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: jpStyle(
        size: 11,
        weight: FontWeight.w700,
        color: color,
        letterSpacing: 0.2 * 11,
      ),
    );
  }
}

/// カードの共通外殻（余白・角丸・落ち影・枠線）。
class _Card extends StatelessWidget {
  const _Card({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ArukuCard(
      borderRadius: 22,
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
      shadow: const [_cardShadow],
      child: child,
    );
  }
}

/// カード左側の角丸アイコン枠（56x56）。
class _CardIcon extends StatelessWidget {
  const _CardIcon({required this.icon, required this.bg});
  final Widget icon;
  final Color bg;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Center(child: icon),
    );
  }
}

class _FeatureCard extends StatelessWidget {
  const _FeatureCard({
    required this.icon,
    required this.iconBg,
    required this.title,
    required this.subtitle,
  });

  final Widget icon;
  final Color iconBg;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _Card(
      child: Row(
        children: [
          _CardIcon(icon: icon, bg: iconBg),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: jpStyle(
                    size: 15,
                    weight: FontWeight.w700,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  style: jpStyle(
                    size: 12,
                    weight: FontWeight.w500,
                    color: c.ink3,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StatsTeaser extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _Card(
      child: Row(
        children: [
          _CardIcon(
            icon: Ic.fire(size: 28, color: c.burnt),
            bg: c.burntSoft,
          ),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '最初の1週間で',
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w600,
                    color: c.ink3,
                    letterSpacing: 0.06 * 11,
                  ),
                ),
                const SizedBox(height: 2),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      '${AppConstants.weeklyKcalEstimate ~/ 1000},${(AppConstants.weeklyKcalEstimate % 1000).toString().padLeft(3, '0')}',
                      style: numStyle(
                        size: 32,
                        weight: FontWeight.w600,
                        color: c.ink,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'kcal',
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w700,
                        color: c.ink2,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        '通勤を歩くだけで',
                        style: jpStyle(
                          size: 12,
                          weight: FontWeight.w500,
                          color: c.ink3,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CTAButton extends StatelessWidget {
  const _CTAButton({required this.label, required this.onPressed});
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuButton(
      label: label,
      onPressed: onPressed,
      backgroundColor: c.moss500,
      height: 56,
      borderRadius: 18,
      shadow: const [
        BoxShadow(
          color: ArukuColors.shadowCtaOnboarding,
          blurRadius: 24,
          offset: Offset(0, 8),
        ),
      ],
      textStyle: jpStyle(
        size: 17,
        weight: FontWeight.w700,
        color: c.ivory,
        letterSpacing: 0.04 * 17,
      ),
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter(this.color, {required this.large});
  final Color color;
  final bool large;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = color;
    final path = Path();
    if (large) {
      path.moveTo(size.width * 0.5, size.height * 0.075);
      path.cubicTo(
        size.width * 0.875,
        size.height * 0.15,
        size.width * 0.9,
        size.height * 0.5,
        size.width * 0.5,
        size.height * 0.9,
      );
      path.cubicTo(
        size.width * 0.15,
        size.height * 0.85,
        size.width * 0.125,
        size.height * 0.5,
        size.width * 0.5,
        size.height * 0.075,
      );
    } else {
      path.moveTo(size.width * 0.25, size.height * 0.05);
      path.cubicTo(
        size.width * 0.7,
        size.height * 0.1,
        size.width * 0.8,
        size.height * 0.45,
        size.width * 0.35,
        size.height * 0.85,
      );
      path.cubicTo(
        size.width * 0.075,
        size.height * 0.75,
        size.width * 0.075,
        size.height * 0.45,
        size.width * 0.25,
        size.height * 0.05,
      );
    }
    path.close();
    canvas.drawPath(path, p);
  }

  @override
  bool shouldRepaint(_BlobPainter old) => old.color != color;
}
