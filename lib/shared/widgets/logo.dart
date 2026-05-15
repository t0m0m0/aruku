import 'package:flutter/material.dart';

import '../../core/theme/aruku_theme.dart';

class ArukuLogo extends StatelessWidget {
  const ArukuLogo({super.key, this.size = 44, this.color, this.ivory});

  final double size;
  final Color? color;
  final Color? ivory;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final bg = color ?? c.moss500;
    final fg = ivory ?? c.ivory;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(size / 3),
        boxShadow: const [
          BoxShadow(
            color: Color(0x3836501E),
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Center(
        child: SizedBox(
          width: size * 0.65,
          height: size * 0.65,
          child: CustomPaint(painter: _LogoPainter(fg)),
        ),
      ),
    );
  }
}

class _LogoPainter extends CustomPainter {
  _LogoPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 24.0;
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final path = Path()
      ..moveTo(19 * s, 5 * s)
      ..cubicTo(9 * s, 5 * s, 5 * s, 11 * s, 5 * s, 16 * s)
      ..cubicTo(6 * s, 10 * s, 11 * s, 7 * s, 17 * s, 6 * s)
      ..cubicTo(16 * s, 10 * s, 15 * s, 13 * s, 12 * s, 14.5 * s);
    canvas.drawPath(path, stroke);
    final fill = Paint()..color = color;
    canvas.drawCircle(Offset(7 * s, 18.5 * s), 1.4 * s, fill);
  }

  @override
  bool shouldRepaint(_LogoPainter old) => old.color != color;
}
