part of 'result_screen.dart';

class _TotalsStrip extends StatelessWidget {
  const _TotalsStrip({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 16),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: c.hairline),
          bottom: BorderSide(color: c.hairline),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 11,
            child: _Metric(
              label: '所要時間',
              value: _DurationValue(minutes: route.totalMin),
            ),
          ),
          Expanded(
            flex: 10,
            child: _Metric(
              label: '徒歩距離',
              divider: true,
              value: _ValueWithUnit(
                value: route.walkKm.toStringAsFixed(1),
                unit: 'km',
              ),
            ),
          ),
          Expanded(
            flex: 12,
            child: _Metric(
              label: '消費カロリー',
              divider: true,
              value: _ValueWithUnit(
                value: '${route.kcal}',
                unit: 'kcal',
                valueSize: 28,
                valueColor: c.burnt,
                unitColor: c.burnt,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 集計ストリップ1指標分。キャプション（上）＋値（下）を上揃えで描画する。
class _Metric extends StatelessWidget {
  const _Metric({
    required this.label,
    required this.value,
    this.divider = false,
  });

  final String label;
  final Widget value;
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: jpStyle(
            size: 10,
            weight: FontWeight.w700,
            color: c.ink3,
            letterSpacing: 0.4,
          ),
        ),
        const SizedBox(height: 7),
        value,
      ],
    );
    if (!divider) return content;
    return Container(
      margin: const EdgeInsets.only(left: 12),
      padding: const EdgeInsets.only(left: 12),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: c.hairline)),
      ),
      child: content,
    );
  }
}

/// 数値＋単位をベースライン揃えで描画する。
class _ValueWithUnit extends StatelessWidget {
  const _ValueWithUnit({
    required this.value,
    required this.unit,
    this.valueSize = 22,
    this.valueColor,
    this.unitColor,
  });

  final String value;
  final String unit;
  final double valueSize;
  final Color? valueColor;
  final Color? unitColor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text(
          value,
          style: numStyle(
            size: valueSize,
            weight: FontWeight.w500,
            color: valueColor ?? c.ink,
          ),
        ),
        const SizedBox(width: 3),
        Text(
          unit,
          style: jpStyle(
            size: 11,
            weight: FontWeight.w700,
            color: unitColor ?? c.ink3,
          ),
        ),
      ],
    );
  }
}

/// 所要時間を「数字(Mono)＋単位(JP)」に分割して1行で描画する。
///
/// 数字と「時間/分」を別Textに分けることで、Mono書体と日本語のフォント混植や
/// スペース位置での折り返しを防ぐ。
class _DurationValue extends StatelessWidget {
  const _DurationValue({required this.minutes});

  final int minutes;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final num = numStyle(size: 22, weight: FontWeight.w500, color: c.ink);
    final unit = jpStyle(size: 12, weight: FontWeight.w700, color: c.ink3);

    if (minutes <= 0) {
      return Text('—', style: num);
    }

    final h = minutes ~/ 60;
    final m = minutes % 60;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        if (h > 0) ...[
          Text('$h', style: num),
          Text('時間', style: unit),
          const SizedBox(width: 2),
          Text(m.toString().padLeft(2, '0'), style: num),
          Text('分', style: unit),
        ] else ...[
          Text('$m', style: num),
          Text('分', style: unit),
        ],
      ],
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
                '距離の ${(route.walkRatio * 100).round()}% を歩いて移動',
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
