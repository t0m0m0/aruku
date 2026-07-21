part of 'result_screen.dart';

/// タイムライン上の区間カード1枚が、行程進捗（[JourneyProgress]）に対して
/// どの状態かを表す（#305）。journey 未開始（[none]）では従来どおり無地。
enum _LegState { none, done, current, upcoming }

class _Timeline extends StatelessWidget {
  const _Timeline({required this.route, this.journey});
  final RoutePlan route;

  /// 現在案内中の区間進捗。null（未開始）なら全カードを [_LegState.none] のまま
  /// 従来表示にする。
  final JourneyProgress? journey;

  _LegState _legStateFor(int segIndex) {
    final j = journey;
    if (j == null) return _LegState.none;
    if (segIndex < j.currentLegIndex) return _LegState.done;
    if (segIndex == j.currentLegIndex) return _LegState.current;
    return _LegState.upcoming;
  }

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
        children.add(
          _TimelineSegmentRow(
            seg: segs[segCursor],
            legState: _legStateFor(segCursor),
          ),
        );
        segCursor++;
      } else if (!node.cardBelow && i < nodes.length - 1) {
        children.add(const _TimelineConnectorRow());
      }
    }
    // カード全体が 1 つのスクロールに包まれるため、ここでは素の Column を返す
    // （内側にもう 1 つ縦スクロールを入れ子にしない）。
    return Column(children: children);
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
  const _TimelineSegmentRow({
    required this.seg,
    this.legState = _LegState.none,
  });
  final RouteSegment seg;

  /// journey 進捗に対するこのカードの状態（#305）。[_LegState.none] は従来表示。
  final _LegState legState;

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
    // バス専用のアイコン・色は未デザインのため、当面は電車と同じ見た目を流用する
    // （#249）。#250 の last-resort 候補で実際に描画されるようになった。
    final color = isWalk ? c.moss600 : c.train;
    final defaultLabel = switch (seg.type) {
      SegmentType.walk => l10n.resultWalkLabel,
      SegmentType.train => l10n.resultTrainDefaultLabel,
      SegmentType.bus => l10n.resultBusDefaultLabel,
    };
    // 完了区間は薄く沈め、現在区間は枠を太らせて強調する（#305）。未開始
    // （journey==null）の [_LegState.none] は従来どおり手を入れない。
    final isDone = legState == _LegState.done;
    final isCurrent = legState == _LegState.current;
    return Opacity(
      opacity: isDone ? 0.55 : 1,
      child: Padding(
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
                    color: isWalk
                        ? c.moss50
                        : c.trainSoft.withValues(alpha: 0.3),
                    border: Border.all(
                      color: isCurrent
                          ? c.moss600
                          : (isWalk
                                ? c.moss100
                                : c.train.withValues(alpha: 0.18)),
                      width: isCurrent ? 2 : 1,
                    ),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (legState == _LegState.done || isCurrent)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: _LegStateBadge(done: isDone, l10n: l10n),
                        ),
                      Row(
                        children: [
                          isWalk
                              ? Ic.walk(size: 16, color: color)
                              : Ic.train(size: 16, color: color),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              isWalk
                                  ? defaultLabel
                                  : (seg.line ?? defaultLabel),
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
                              Text(
                                '·',
                                style: jpStyle(size: 11, color: c.ink4),
                              ),
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
      ),
    );
  }
}

/// 完了/進行中を示す小さなバッジ（#305）。journey 未開始（[_LegState.none]）や
/// これから通る区間（[_LegState.upcoming]）では描画しない。
class _LegStateBadge extends StatelessWidget {
  const _LegStateBadge({required this.done, required this.l10n});
  final bool done;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final color = done ? c.ink3 : c.burnt;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        done ? l10n.resultLegDoneLabel : l10n.resultLegCurrentLabel,
        style: jpStyle(size: 10, weight: FontWeight.w800, color: color),
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
