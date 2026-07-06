part of 'result_screen.dart';

class _Timeline extends StatelessWidget {
  const _Timeline({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    final nodes = route.timelineNodes;
    final segs = route.segments;
    final children = <Widget>[];
    // cardBelow:false の駅行（直結乗換の「着」行）はカードを挟まず、次の「発」行へ
    // 短いコネクタで繋ぐ。それ以外の行は順にレッグカードを 1 枚消費する。
    var segCursor = 0;
    for (int i = 0; i < nodes.length; i++) {
      final node = nodes[i];
      children.add(_TimelineNodeRow(node: node));
      if (node.cardBelow && segCursor < segs.length) {
        children.add(_TimelineSegmentRow(seg: segs[segCursor]));
        segCursor++;
      } else if (!node.cardBelow && i < nodes.length - 1) {
        children.add(const _TimelineConnectorRow());
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
              child: Text(
                node.time,
                textAlign: TextAlign.right,
                style: numStyle(
                  size: 11,
                  weight: FontWeight.w700,
                  color: c.ink3,
                ),
              ),
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
                Text(
                  node.place,
                  style: jpStyle(
                    size: 13,
                    weight: FontWeight.w700,
                    color: c.ink,
                  ),
                ),
                if (node.sub.isNotEmpty)
                  Text(
                    node.sub,
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
      ),
    );
  }
}

/// 直結乗換の「着」行と「発」行のあいだを繋ぐ短い実線コネクタ（カードは挟まない）。
class _TimelineConnectorRow extends StatelessWidget {
  const _TimelineConnectorRow();

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          const SizedBox(width: 44),
          const SizedBox(width: 14),
          SizedBox(
            width: 16,
            height: 12,
            child: CustomPaint(
              painter: _SegLinePainter(color: c.train, dashed: false),
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

  /// 区間所要分を「大きい数字＋小さい単位」で組む。60分以上は n時m分 へ分解する。
  List<Widget> _durationParts(int minutes, Color color, AppLocalizations l10n) {
    final num = numStyle(size: 12, weight: FontWeight.w800, color: color);
    final unit = jpStyle(size: 10, weight: FontWeight.w700, color: color);
    if (minutes >= 60) {
      return [
        Text('${minutes ~/ 60}', style: num),
        Text(l10n.resultHourUnit, style: unit),
        Text((minutes % 60).toString().padLeft(2, '0'), style: num),
        Text(l10n.resultMinuteUnit, style: unit),
      ];
    }
    return [
      Text('$minutes', style: num),
      const SizedBox(width: 1),
      Text(l10n.resultMinuteUnit, style: unit),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
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
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: isWalk ? c.moss50 : c.trainSoft.withValues(alpha: 0.3),
                  border: Border.all(
                    color: isWalk ? c.moss100 : c.train.withValues(alpha: 0.18),
                  ),
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
                            isWalk
                                ? l10n.resultWalkLabel
                                : (seg.line ?? l10n.resultTrainDefaultLabel),
                            style: jpStyle(
                              size: 13,
                              weight: FontWeight.w700,
                              color: c.ink,
                            ),
                          ),
                        ),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          children: _durationParts(seg.minutes, color, l10n),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    if (isWalk)
                      Row(
                        children: [
                          Text(
                            '${seg.km!.toStringAsFixed(1)}km',
                            style: numStyle(
                              size: 11,
                              weight: FontWeight.w600,
                              color: c.ink2,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            '·',
                            style: jpStyle(
                              size: 11,
                              weight: FontWeight.w600,
                              color: c.ink4,
                            ),
                          ),
                          const SizedBox(width: 8),
                          RichText(
                            text: TextSpan(
                              style: jpStyle(
                                size: 11,
                                weight: FontWeight.w800,
                                color: c.burnt,
                              ),
                              children: [
                                const TextSpan(text: '+'),
                                TextSpan(text: '${seg.kcal}'),
                                const TextSpan(text: ' kcal'),
                              ],
                            ),
                          ),
                        ],
                      )
                    else ...[
                      // 発着時刻はタイムライン左カラム（乗車駅=発・降車駅=着）に出すため
                      // カード内には重複表示しない（案B）。
                      Row(
                        children: [
                          Text(
                            '${seg.fromName} → ${seg.toName}',
                            style: jpStyle(
                              size: 11,
                              weight: FontWeight.w600,
                              color: c.ink2,
                            ),
                          ),
                          // 運賃はハイブリッド区間などで欠落し得る。null のときは
                          // 区切りと運賃を出さず「¥null」表示を防ぐ。
                          if (seg.fare != null) ...[
                            const SizedBox(width: 8),
                            Text('·', style: jpStyle(size: 11, color: c.ink4)),
                            const SizedBox(width: 8),
                            Text(
                              '¥${seg.fare}',
                              style: numStyle(
                                size: 11,
                                weight: FontWeight.w600,
                                color: c.ink2,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
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
        canvas.drawLine(
          Offset(x, y),
          Offset(x, math.min(y + dash, size.height)),
          paint,
        );
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
