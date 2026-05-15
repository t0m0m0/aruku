import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/route_plan.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_map.dart';

class ResultScreen extends ConsumerWidget {
  const ResultScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final route = ref.watch(appStateProvider).route ?? RoutePlan.mock;

    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Column(
          children: [
            // Mini header
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
              child: Row(
                children: [
                  _HeaderButton(
                    child: Ic.chevron(size: 18, color: c.ink, dir: ChevronDir.left),
                    onTap: () => notifier.go(Screen.home),
                  ),
                  Expanded(
                    child: Center(
                      child: Text('5月15日 (金) · 9:32 出発',
                          style: jpStyle(
                              size: 12,
                              weight: FontWeight.w700,
                              color: c.ink3)),
                    ),
                  ),
                  _HeaderButton(
                    child: Ic.star(size: 18, color: c.ink),
                    onTap: () {},
                  ),
                ],
              ),
            ),

            // Journey card
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
                child: Container(
                  decoration: BoxDecoration(
                    color: c.paper,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: c.hairline),
                    boxShadow: const [
                      BoxShadow(
                          color: Color(0x1422361E),
                          blurRadius: 28,
                          offset: Offset(0, 12)),
                    ],
                  ),
                  padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
                  child: Column(
                    children: [
                      _JourneyHeader(route: route),
                      const SizedBox(height: 14),
                      _TotalsStrip(route: route),
                      const SizedBox(height: 12),
                      _WalkRatioRow(route: route),
                      const SizedBox(height: 14),
                      Expanded(child: _Timeline(route: route)),
                      const SizedBox(height: 8),
                      _CtaRow(onNav: () => notifier.go(Screen.nav)),
                    ],
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

class _HeaderButton extends StatelessWidget {
  const _HeaderButton({required this.child, required this.onTap});
  final Widget child;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.paper,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Ink(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: c.hairline),
          ),
          child: Center(child: child),
        ),
      ),
    );
  }
}

class _JourneyHeader extends StatelessWidget {
  const _JourneyHeader({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('FROM',
                  style: jpStyle(
                      size: 10,
                      weight: FontWeight.w800,
                      color: c.moss600,
                      letterSpacing: 0.12 * 10)),
              const SizedBox(height: 2),
              Text(route.from,
                  style: jpStyle(
                      size: 16, weight: FontWeight.w800, color: c.ink)),
            ],
          ),
        ),
        // Thumb map
        Container(
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: c.hairline),
          ),
          clipBehavior: Clip.antiAlias,
          child: const ArukuMap(variant: ArukuMapVariant.thumb),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('TO',
                  style: jpStyle(
                      size: 10,
                      weight: FontWeight.w800,
                      color: c.burnt,
                      letterSpacing: 0.12 * 10)),
              const SizedBox(height: 2),
              Text(route.to,
                  textAlign: TextAlign.end,
                  style: jpStyle(
                      size: 16, weight: FontWeight.w800, color: c.ink)),
            ],
          ),
        ),
      ],
    );
  }
}

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
                Text('KCAL',
                    style: jpStyle(
                        size: 10,
                        weight: FontWeight.w800,
                        color: c.burnt,
                        letterSpacing: 0.1 * 10)),
                Text('${route.kcal}',
                    style: numStyle(
                        size: 38, weight: FontWeight.w500, color: c.burnt)),
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
                    Text('WALK',
                        style: jpStyle(
                            size: 10,
                            weight: FontWeight.w800,
                            color: c.ink3,
                            letterSpacing: 0.1 * 10)),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text(route.walkKm.toStringAsFixed(1),
                            style: numStyle(
                                size: 22,
                                weight: FontWeight.w500,
                                color: c.ink)),
                        const SizedBox(width: 3),
                        Text('km',
                            style: jpStyle(
                                size: 11,
                                weight: FontWeight.w700,
                                color: c.ink)),
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
                    Text('TOTAL',
                        style: jpStyle(
                            size: 10,
                            weight: FontWeight.w800,
                            color: c.ink3,
                            letterSpacing: 0.1 * 10)),
                    Text(
                        '${route.totalMin ~/ 60}h${(route.totalMin % 60).toString().padLeft(2, '0')}',
                        style: numStyle(
                            size: 22,
                            weight: FontWeight.w500,
                            color: c.ink)),
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
              Text('${(route.walkRatio * 100).round()}% を歩いて移動',
                  style: jpStyle(
                      size: 12, weight: FontWeight.w800, color: c.ink)),
              const SizedBox(height: 2),
              Text(
                '制限 ${(route.budgetMin / 60).toStringAsFixed(1)}時間のうち ${route.totalMin ~/ 60}h${(route.totalMin % 60).toString().padLeft(2, '0')} で到着 · ${route.budgetMin - route.totalMin}分 余裕',
                style: jpStyle(
                    size: 11, weight: FontWeight.w500, color: c.ink3),
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

class _Timeline extends StatelessWidget {
  const _Timeline({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final nodes = route.timelineNodes;
    final segs = route.segments;
    final children = <Widget>[];
    for (int i = 0; i < nodes.length; i++) {
      children.add(_TimelineNodeRow(node: nodes[i]));
      if (i < segs.length) {
        children.add(_TimelineSegmentRow(seg: segs[i]));
      }
    }
    return SingleChildScrollView(child: Column(children: children));
  }
}

class _TimelineNodeRow extends StatelessWidget {
  const _TimelineNodeRow({required this.node});
  final TimelineNode node;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 44,
            child: Padding(
              padding: const EdgeInsets.only(top: 1, right: 4),
              child: Text(node.time,
                  textAlign: TextAlign.right,
                  style: numStyle(
                      size: 11, weight: FontWeight.w700, color: c.ink3)),
            ),
          ),
          const SizedBox(width: 14),
          SizedBox(
            width: 16,
            child: Padding(
              padding: const EdgeInsets.only(left: 6, top: 4),
              child: Container(
                width: 4,
                height: 4,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: c.ink2,
                ),
              ),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(node.place,
                    style: jpStyle(
                        size: 13, weight: FontWeight.w700, color: c.ink)),
                if (node.sub.isNotEmpty)
                  Text(node.sub,
                      style: jpStyle(
                          size: 11,
                          weight: FontWeight.w500,
                          color: c.ink3)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TimelineSegmentRow extends StatelessWidget {
  const _TimelineSegmentRow({required this.seg});
  final RouteSegment seg;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final isWalk = seg.type == SegmentType.walk;
    final color = isWalk ? c.moss600 : c.train;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(width: 44),
            const SizedBox(width: 14),
            SizedBox(
              width: 16,
              child: CustomPaint(
                painter: _SegLinePainter(color: color, dashed: isWalk),
              ),
            ),
            Expanded(
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color:
                      isWalk ? c.moss50 : c.trainSoft.withValues(alpha: 0.3),
                  border: Border.all(
                      color: isWalk
                          ? c.moss100
                          : c.train.withValues(alpha: 0.18)),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        isWalk
                            ? Ic.walk(size: 16, color: color)
                            : Ic.train(size: 16, color: color),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            isWalk ? '徒歩' : (seg.line ?? '電車'),
                            style: jpStyle(
                                size: 13,
                                weight: FontWeight.w700,
                                color: c.ink),
                          ),
                        ),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: [
                            Text('${seg.minutes}',
                                style: numStyle(
                                    size: 12,
                                    weight: FontWeight.w800,
                                    color: color)),
                            const SizedBox(width: 1),
                            Text('min',
                                style: jpStyle(
                                    size: 10,
                                    weight: FontWeight.w700,
                                    color: color)),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    if (isWalk)
                      Row(
                        children: [
                          Text('${seg.km!.toStringAsFixed(1)}km',
                              style: numStyle(
                                  size: 11,
                                  weight: FontWeight.w600,
                                  color: c.ink2)),
                          const SizedBox(width: 8),
                          Text('·',
                              style: jpStyle(
                                  size: 11,
                                  weight: FontWeight.w600,
                                  color: c.ink4)),
                          const SizedBox(width: 8),
                          RichText(
                            text: TextSpan(
                              style: jpStyle(
                                  size: 11,
                                  weight: FontWeight.w800,
                                  color: c.burnt),
                              children: [
                                const TextSpan(text: '+'),
                                TextSpan(text: '${seg.kcal}'),
                                const TextSpan(text: ' kcal'),
                              ],
                            ),
                          ),
                        ],
                      )
                    else
                      Row(
                        children: [
                          Text('${seg.fromName} → ${seg.toName}',
                              style: jpStyle(
                                  size: 11,
                                  weight: FontWeight.w600,
                                  color: c.ink2)),
                          const SizedBox(width: 8),
                          Text('·',
                              style: jpStyle(size: 11, color: c.ink4)),
                          const SizedBox(width: 8),
                          Text('¥${seg.fare}',
                              style: numStyle(
                                  size: 11,
                                  weight: FontWeight.w600,
                                  color: c.ink2)),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SegLinePainter extends CustomPainter {
  _SegLinePainter({required this.color, required this.dashed});
  final Color color;
  final bool dashed;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    final x = size.width / 2;
    if (dashed) {
      const dash = 3.0;
      const gap = 4.0;
      double y = 0;
      while (y < size.height) {
        canvas.drawLine(Offset(x, y), Offset(x, math.min(y + dash, size.height)), paint);
        y += dash + gap;
      }
    } else {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
  }

  @override
  bool shouldRepaint(_SegLinePainter old) =>
      old.color != color || old.dashed != dashed;
}

class _CtaRow extends StatelessWidget {
  const _CtaRow({required this.onNav});
  final VoidCallback onNav;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      children: [
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(
            color: c.paper,
            border: Border.all(color: c.hairline),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Center(child: Ic.search(size: 18, color: c.ink2)),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Material(
            color: c.moss600,
            borderRadius: BorderRadius.circular(16),
            child: InkWell(
              onTap: onNav,
              borderRadius: BorderRadius.circular(16),
              child: Ink(
                height: 52,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  boxShadow: const [
                    BoxShadow(
                        color: Color(0x5235501A),
                        blurRadius: 20,
                        offset: Offset(0, 8)),
                  ],
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Ic.arrowUp(size: 18, color: c.ivory),
                    const SizedBox(width: 8),
                    Text('このルートで歩く',
                        style: jpStyle(
                            size: 16,
                            weight: FontWeight.w800,
                            color: c.ivory,
                            letterSpacing: 0.06 * 16)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
