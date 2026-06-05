import 'package:flutter/material.dart';

/// Aruku icon set — line-style SVG paths drawn as CustomPaint.
/// All icons share consistent stroke (1.6–1.8), round caps and joins.
class Ic extends StatelessWidget {
  const Ic._({required this.painter, required this.size});

  final CustomPainter painter;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: painter),
    );
  }

  static Widget walk({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_walk, color));
  static Widget train({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_train, color));
  static Widget pin({
    double size = 20,
    required Color color,
    bool filled = false,
  }) => Ic._(
    size: size,
    painter: _IconPainter(filled ? _pinFilled : _pin, color, filled: filled),
  );
  static Widget fire({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_fire, color, filled: true));
  static Widget settings({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_settings, color));
  static Widget compass({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_compass, color));
  static Widget swap({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_swap, color));
  static Widget clock({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_clock, color));
  static Widget chevron({
    double size = 20,
    required Color color,
    required ChevronDir dir,
  }) => Ic._(size: size, painter: _ChevronPainter(dir, color));
  static Widget routes({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_routes, color));
  static Widget close({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_close, color));
  static Widget flag({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_flag, color));
  static Widget search({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_search, color));
  static Widget history({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_history, color));
  static Widget leaf({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_leaf, color));
  static Widget sparkle({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_sparkle, color, filled: true));
  static Widget star({
    double size = 20,
    required Color color,
    bool filled = false,
  }) => Ic._(
    size: size,
    painter: _IconPainter(_star, color, filled: filled),
  );
  static Widget arrowUp({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_arrowUp, color));
  static Widget layers({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_layers, color));
  static Widget pause({double size = 20, required Color color}) =>
      Ic._(size: size, painter: _IconPainter(_pause, color, filled: true));
}

enum ChevronDir { left, right, up, down }

typedef _DrawFn = void Function(Canvas canvas, Paint stroke, double s);

class _IconPainter extends CustomPainter {
  _IconPainter(this.draw, this.color, {this.filled = false});

  final _DrawFn draw;
  final Color color;
  final bool filled;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 24.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.7
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = filled ? PaintingStyle.fill : PaintingStyle.stroke;
    draw(canvas, paint, s);
  }

  @override
  bool shouldRepaint(_IconPainter old) =>
      old.color != color || old.filled != filled;
}

class _ChevronPainter extends CustomPainter {
  _ChevronPainter(this.dir, this.color);
  final ChevronDir dir;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 24.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final path = Path();
    switch (dir) {
      case ChevronDir.left:
        path.moveTo(15 * s, 6 * s);
        path.lineTo(9 * s, 12 * s);
        path.lineTo(15 * s, 18 * s);
        break;
      case ChevronDir.right:
        path.moveTo(9 * s, 6 * s);
        path.lineTo(15 * s, 12 * s);
        path.lineTo(9 * s, 18 * s);
        break;
      case ChevronDir.up:
        path.moveTo(6 * s, 15 * s);
        path.lineTo(12 * s, 9 * s);
        path.lineTo(18 * s, 15 * s);
        break;
      case ChevronDir.down:
        path.moveTo(6 * s, 9 * s);
        path.lineTo(12 * s, 15 * s);
        path.lineTo(18 * s, 9 * s);
        break;
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_ChevronPainter old) =>
      old.dir != dir || old.color != color;
}

// ── Path definitions (viewBox 24×24) ────────────────────────────────────

void _walk(Canvas c, Paint p, double s) {
  // Simple walking person
  c.drawCircle(Offset(13 * s, 4.5 * s), 1.8 * s, p..style = PaintingStyle.fill);
  p.style = PaintingStyle.stroke;
  final body = Path()
    ..moveTo(13 * s, 7 * s)
    ..lineTo(10.5 * s, 12 * s)
    ..lineTo(8 * s, 14 * s)
    ..moveTo(13 * s, 7 * s)
    ..lineTo(15.5 * s, 12 * s)
    ..lineTo(15 * s, 16 * s)
    ..lineTo(17 * s, 20 * s)
    ..moveTo(10.5 * s, 12 * s)
    ..lineTo(9 * s, 16 * s)
    ..lineTo(7 * s, 20 * s)
    ..moveTo(15.5 * s, 12 * s)
    ..lineTo(17 * s, 11 * s);
  c.drawPath(body, p);
}

void _train(Canvas c, Paint p, double s) {
  final r = RRect.fromRectAndRadius(
    Rect.fromLTWH(5.5 * s, 3.5 * s, 13 * s, 14 * s),
    Radius.circular(3 * s),
  );
  c.drawRRect(r, p);
  c.drawLine(Offset(5.5 * s, 12 * s), Offset(18.5 * s, 12 * s), p);
  c.drawLine(Offset(8 * s, 21 * s), Offset(6 * s, 23 * s), p);
  c.drawLine(Offset(16 * s, 21 * s), Offset(18 * s, 23 * s), p);
  c.drawCircle(Offset(9 * s, 15 * s), 0.9 * s, p..style = PaintingStyle.fill);
  c.drawCircle(Offset(15 * s, 15 * s), 0.9 * s, p);
  p.style = PaintingStyle.stroke;
}

void _pin(Canvas c, Paint p, double s) {
  final path = Path()
    ..moveTo(12 * s, 22 * s)
    ..cubicTo(5 * s, 14 * s, 5 * s, 10 * s, 5 * s, 10 * s)
    ..arcToPoint(
      Offset(19 * s, 10 * s),
      radius: Radius.circular(7 * s),
      clockwise: true,
    )
    ..cubicTo(19 * s, 10 * s, 19 * s, 14 * s, 12 * s, 22 * s)
    ..close();
  c.drawPath(path, p);
  c.drawCircle(Offset(12 * s, 10 * s), 2.4 * s, p);
}

void _pinFilled(Canvas c, Paint p, double s) {
  final path = Path()
    ..moveTo(12 * s, 22 * s)
    ..cubicTo(5 * s, 14 * s, 5 * s, 10 * s, 5 * s, 10 * s)
    ..arcToPoint(
      Offset(19 * s, 10 * s),
      radius: Radius.circular(7 * s),
      clockwise: true,
    )
    ..cubicTo(19 * s, 10 * s, 19 * s, 14 * s, 12 * s, 22 * s)
    ..close();
  c.drawPath(path, p..style = PaintingStyle.fill);
}

void _fire(Canvas c, Paint p, double s) {
  final path = Path()
    ..moveTo(12 * s, 3 * s)
    ..cubicTo(9 * s, 7 * s, 6 * s, 9 * s, 6 * s, 14 * s)
    ..cubicTo(6 * s, 18 * s, 9 * s, 21 * s, 12 * s, 21 * s)
    ..cubicTo(15 * s, 21 * s, 18 * s, 18 * s, 18 * s, 14 * s)
    ..cubicTo(18 * s, 11 * s, 16 * s, 9 * s, 15 * s, 7 * s)
    ..cubicTo(14 * s, 10 * s, 12 * s, 11 * s, 12 * s, 8 * s)
    ..cubicTo(12 * s, 6 * s, 13 * s, 5 * s, 12 * s, 3 * s)
    ..close();
  c.drawPath(path, p);
}

void _settings(Canvas c, Paint p, double s) {
  c.drawCircle(Offset(12 * s, 12 * s), 3 * s, p);
  c.drawCircle(Offset(12 * s, 12 * s), 8 * s, p);
}

void _compass(Canvas c, Paint p, double s) {
  c.drawCircle(Offset(12 * s, 12 * s), 9 * s, p);
  final needle = Path()
    ..moveTo(12 * s, 6 * s)
    ..lineTo(14 * s, 12 * s)
    ..lineTo(12 * s, 18 * s)
    ..lineTo(10 * s, 12 * s)
    ..close();
  c.drawPath(needle, p);
}

void _swap(Canvas c, Paint p, double s) {
  c.drawLine(Offset(7 * s, 8 * s), Offset(17 * s, 8 * s), p);
  final left = Path()
    ..moveTo(10 * s, 5 * s)
    ..lineTo(7 * s, 8 * s)
    ..lineTo(10 * s, 11 * s);
  c.drawPath(left, p);
  c.drawLine(Offset(7 * s, 16 * s), Offset(17 * s, 16 * s), p);
  final right = Path()
    ..moveTo(14 * s, 13 * s)
    ..lineTo(17 * s, 16 * s)
    ..lineTo(14 * s, 19 * s);
  c.drawPath(right, p);
}

void _clock(Canvas c, Paint p, double s) {
  c.drawCircle(Offset(12 * s, 12 * s), 9 * s, p);
  final hands = Path()
    ..moveTo(12 * s, 7 * s)
    ..lineTo(12 * s, 12 * s)
    ..lineTo(16 * s, 14 * s);
  c.drawPath(hands, p);
}

void _routes(Canvas c, Paint p, double s) {
  c.drawCircle(Offset(6 * s, 6 * s), 2 * s, p);
  c.drawCircle(Offset(18 * s, 18 * s), 2 * s, p);
  final path = Path()
    ..moveTo(6 * s, 9 * s)
    ..cubicTo(6 * s, 14 * s, 12 * s, 10 * s, 12 * s, 14 * s)
    ..cubicTo(12 * s, 18 * s, 16 * s, 16 * s, 18 * s, 16 * s);
  c.drawPath(path, p);
}

void _close(Canvas c, Paint p, double s) {
  c.drawLine(Offset(7 * s, 7 * s), Offset(17 * s, 17 * s), p);
  c.drawLine(Offset(17 * s, 7 * s), Offset(7 * s, 17 * s), p);
}

void _flag(Canvas c, Paint p, double s) {
  c.drawLine(Offset(6 * s, 4 * s), Offset(6 * s, 22 * s), p);
  final flag = Path()
    ..moveTo(6 * s, 5 * s)
    ..lineTo(18 * s, 5 * s)
    ..lineTo(15 * s, 9 * s)
    ..lineTo(18 * s, 13 * s)
    ..lineTo(6 * s, 13 * s)
    ..close();
  c.drawPath(flag, p);
}

void _search(Canvas c, Paint p, double s) {
  c.drawCircle(Offset(11 * s, 11 * s), 6 * s, p);
  c.drawLine(Offset(15.5 * s, 15.5 * s), Offset(20 * s, 20 * s), p);
}

void _history(Canvas c, Paint p, double s) {
  c.drawArc(
    Rect.fromCircle(center: Offset(12 * s, 12 * s), radius: 8 * s),
    -0.4,
    5.6,
    false,
    p,
  );
  final arrow = Path()
    ..moveTo(4 * s, 7 * s)
    ..lineTo(4 * s, 11 * s)
    ..lineTo(8 * s, 11 * s);
  c.drawPath(arrow, p);
  final hands = Path()
    ..moveTo(12 * s, 8 * s)
    ..lineTo(12 * s, 12 * s)
    ..lineTo(15 * s, 14 * s);
  c.drawPath(hands, p);
}

void _leaf(Canvas c, Paint p, double s) {
  final leaf = Path()
    ..moveTo(20 * s, 4 * s)
    ..cubicTo(20 * s, 4 * s, 12 * s, 4 * s, 8 * s, 8 * s)
    ..cubicTo(4 * s, 12 * s, 4 * s, 20 * s, 4 * s, 20 * s)
    ..cubicTo(4 * s, 20 * s, 12 * s, 20 * s, 16 * s, 16 * s)
    ..cubicTo(20 * s, 12 * s, 20 * s, 4 * s, 20 * s, 4 * s)
    ..close();
  c.drawPath(leaf, p);
  c.drawLine(Offset(4 * s, 20 * s), Offset(14 * s, 10 * s), p);
}

void _sparkle(Canvas c, Paint p, double s) {
  final star = Path()
    ..moveTo(12 * s, 3 * s)
    ..lineTo(14 * s, 10 * s)
    ..lineTo(21 * s, 12 * s)
    ..lineTo(14 * s, 14 * s)
    ..lineTo(12 * s, 21 * s)
    ..lineTo(10 * s, 14 * s)
    ..lineTo(3 * s, 12 * s)
    ..lineTo(10 * s, 10 * s)
    ..close();
  c.drawPath(star, p);
}

void _star(Canvas c, Paint p, double s) {
  final star = Path()
    ..moveTo(12 * s, 3 * s)
    ..lineTo(14.4 * s, 9.2 * s)
    ..lineTo(21 * s, 9.6 * s)
    ..lineTo(15.8 * s, 13.8 * s)
    ..lineTo(17.6 * s, 20.4 * s)
    ..lineTo(12 * s, 16.8 * s)
    ..lineTo(6.4 * s, 20.4 * s)
    ..lineTo(8.2 * s, 13.8 * s)
    ..lineTo(3 * s, 9.6 * s)
    ..lineTo(9.6 * s, 9.2 * s)
    ..close();
  c.drawPath(star, p);
}

void _arrowUp(Canvas c, Paint p, double s) {
  c.drawLine(Offset(12 * s, 4 * s), Offset(12 * s, 20 * s), p);
  final head = Path()
    ..moveTo(6 * s, 10 * s)
    ..lineTo(12 * s, 4 * s)
    ..lineTo(18 * s, 10 * s);
  c.drawPath(head, p);
}

void _layers(Canvas c, Paint p, double s) {
  final l1 = Path()
    ..moveTo(12 * s, 3 * s)
    ..lineTo(21 * s, 8 * s)
    ..lineTo(12 * s, 13 * s)
    ..lineTo(3 * s, 8 * s)
    ..close();
  c.drawPath(l1, p);
  final l2 = Path()
    ..moveTo(3 * s, 12 * s)
    ..lineTo(12 * s, 17 * s)
    ..lineTo(21 * s, 12 * s);
  c.drawPath(l2, p);
  final l3 = Path()
    ..moveTo(3 * s, 16 * s)
    ..lineTo(12 * s, 21 * s)
    ..lineTo(21 * s, 16 * s);
  c.drawPath(l3, p);
}

void _pause(Canvas c, Paint p, double s) {
  c.drawRRect(
    RRect.fromRectAndRadius(
      Rect.fromLTWH(7 * s, 5 * s, 3 * s, 14 * s),
      Radius.circular(1 * s),
    ),
    p,
  );
  c.drawRRect(
    RRect.fromRectAndRadius(
      Rect.fromLTWH(14 * s, 5 * s, 3 * s, 14 * s),
      Radius.circular(1 * s),
    ),
    p,
  );
}
