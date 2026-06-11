part of 'result_screen.dart';

class _TotalsStrip extends StatelessWidget {
  const _TotalsStrip({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: c.hairline),
          bottom: BorderSide(color: c.hairline),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            flex: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${route.kcal}',
                  style: numStyle(
                    size: 38,
                    weight: FontWeight.w500,
                    color: c.burnt,
                  ),
                ),
                Text(
                  'KCAL',
                  style: jpStyle(
                    size: 10,
                    weight: FontWeight.w800,
                    color: c.burnt,
                    letterSpacing: 0.1 * 10,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            flex: 10,
            child: Padding(
              padding: const EdgeInsets.only(left: 10),
              child: Container(
                decoration: BoxDecoration(
                  border: Border(left: BorderSide(color: c.hairline)),
                ),
                padding: const EdgeInsets.only(left: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text(
                          route.walkKm.toStringAsFixed(1),
                          style: numStyle(
                            size: 22,
                            weight: FontWeight.w500,
                            color: c.ink,
                          ),
                        ),
                        const SizedBox(width: 3),
                        Text(
                          'km',
                          style: jpStyle(
                            size: 11,
                            weight: FontWeight.w700,
                            color: c.ink,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
          Expanded(
            flex: 10,
            child: Padding(
              padding: const EdgeInsets.only(left: 10),
              child: Container(
                decoration: BoxDecoration(
                  border: Border(left: BorderSide(color: c.hairline)),
                ),
                padding: const EdgeInsets.only(left: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      TimeValue.formatBudget(route.totalMin),
                      style: numStyle(
                        size: 22,
                        weight: FontWeight.w500,
                        color: c.ink,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _WalkRatioRow extends StatelessWidget {
  const _WalkRatioRow({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      children: [
        SizedBox(
          width: 46,
          height: 46,
          child: CustomPaint(
            painter: _RatioRingPainter(
              ratio: route.walkRatio,
              bg: c.moss100,
              fg: c.moss500,
              label: '${(route.walkRatio * 100).round()}%',
              labelColor: c.moss700,
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${(route.walkRatio * 100).round()}% を歩いて移動',
                style: jpStyle(size: 12, weight: FontWeight.w800, color: c.ink),
              ),
              const SizedBox(height: 2),
              Text(
                '制限 ${TimeValue.formatBudget(route.budgetMin)}のうち ${TimeValue.formatBudget(route.totalMin)} で到着 · ${route.budgetMin - route.totalMin}分 余裕',
                style: jpStyle(
                  size: 11,
                  weight: FontWeight.w500,
                  color: c.ink3,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _RatioRingPainter extends CustomPainter {
  _RatioRingPainter({
    required this.ratio,
    required this.bg,
    required this.fg,
    required this.label,
    required this.labelColor,
  });
  final double ratio;
  final Color bg;
  final Color fg;
  final String label;
  final Color labelColor;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    const radius = 19.0;
    final track = Paint()
      ..color = bg
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6;
    canvas.drawCircle(center, radius, track);

    final stroke = Paint()
      ..color = fg
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6
      ..strokeCap = StrokeCap.round;
    final sweep = 2 * math.pi * ratio;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      sweep,
      false,
      stroke,
    );

    final tp = TextPainter(
      text: TextSpan(
        text: label,
        style: numStyle(size: 11, weight: FontWeight.w800, color: labelColor),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(
      canvas,
      Offset(center.dx - tp.width / 2, center.dy - tp.height / 2),
    );
  }

  @override
  bool shouldRepaint(_RatioRingPainter old) =>
      old.ratio != ratio || old.fg != fg;
}
