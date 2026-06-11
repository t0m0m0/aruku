part of 'home_screen.dart';

class _DestinationCard extends StatelessWidget {
  const _DestinationCard({
    required this.departure,
    required this.destination,
    required this.onTapDeparture,
    required this.onTapDestination,
    required this.onRefreshLocation,
  });
  final String departure;
  final String? destination;
  final VoidCallback onTapDeparture;
  final VoidCallback onTapDestination;
  final VoidCallback onRefreshLocation;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuCard(
      borderRadius: 22,
      shadow: const [
        BoxShadow(
          color: ArukuTokens.shadowCardSubtle,
          blurRadius: 24,
          offset: Offset(0, 8),
        ),
      ],
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Stack(
        children: [
          // dot column
          Positioned(
            left: 16,
            top: 24,
            bottom: 24,
            child: Column(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: c.moss500,
                    shape: BoxShape.circle,
                    border: Border.all(color: c.moss100, width: 3),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Container(width: 2, color: c.moss200),
                  ),
                ),
                Ic.pin(size: 16, color: c.burnt, filled: true),
              ],
            ),
          ),
          Column(
            children: [
              // From
              InkWell(
                onTap: onTapDeparture,
                borderRadius: BorderRadius.circular(12),
                child: Ink(
                  padding: const EdgeInsets.fromLTRB(38, 12, 0, 12),
                  decoration: BoxDecoration(
                    border: Border(bottom: BorderSide(color: c.hairline)),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '出発',
                              style: jpStyle(
                                size: 13,
                                weight: FontWeight.w700,
                                color: c.ink2,
                                letterSpacing: 0.04 * 13,
                              ),
                            ),
                            Text(
                              departure,
                              style: jpStyle(
                                size: 16,
                                weight: FontWeight.w700,
                                color: c.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                      // 現在地を再取得するコンパスボタン（HIG: 44px タップ領域）
                      _IconHit(
                        key: const Key('home-origin-compass'),
                        label: '現在地を再取得',
                        onTap: onRefreshLocation,
                        child: Ic.compass(size: 20, color: c.ink2),
                      ),
                    ],
                  ),
                ),
              ),
              // To
              InkWell(
                onTap: onTapDestination,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(38, 12, 0, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '目的地',
                              style: jpStyle(
                                size: 13,
                                weight: FontWeight.w700,
                                color: c.ink2,
                                letterSpacing: 0.04 * 13,
                              ),
                            ),
                            Text(
                              destination ?? 'どこへ歩く?',
                              style: jpStyle(
                                size: 16,
                                weight: destination != null
                                    ? FontWeight.w700
                                    : FontWeight.w600,
                                color: destination != null ? c.ink : c.ink3,
                              ),
                            ),
                          ],
                        ),
                      ),
                      // 検索チップ（moss50 角丸）— コンパスと同じく 44px タップ
                      // 領域＋ボタン意味付けで一貫させる。
                      _IconHit(
                        key: const Key('home-destination-search'),
                        label: '目的地を検索',
                        onTap: onTapDestination,
                        child: Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(
                            color: c.moss50,
                            borderRadius: BorderRadius.circular(11),
                          ),
                          child: Center(
                            child: Ic.search(size: 17, color: c.moss600),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 44px の最小タップ領域を確保したアイコンボタン（HIG 準拠）。
/// [onTap] が Future を返す間はスピナーを表示し、二重タップを抑止する。
class _IconHit extends StatefulWidget {
  const _IconHit({
    super.key,
    required this.label,
    required this.onTap,
    required this.child,
  });
  final String label;
  final FutureOr<void> Function() onTap;
  final Widget child;

  @override
  State<_IconHit> createState() => _IconHitState();
}

class _IconHitState extends State<_IconHit> {
  bool _busy = false;

  Future<void> _handleTap() async {
    if (_busy) return;
    final result = widget.onTap();
    if (result is! Future) return; // 同期処理ならスピナーは出さない。
    setState(() => _busy = true);
    try {
      await result;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      button: true,
      label: widget.label,
      enabled: !_busy,
      child: InkResponse(
        onTap: _busy ? null : _handleTap,
        radius: 24,
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(
            child: _busy
                ? SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(c.ink2),
                    ),
                  )
                : widget.child,
          ),
        ),
      ),
    );
  }
}

class _TimeField extends StatelessWidget {
  const _TimeField({
    required this.label,
    required this.time,
    required this.date,
    required this.sub,
    required this.anchored,
    required this.onTap,
  });

  final String label;
  final String time;
  final String? date;
  final String sub;
  final bool anchored;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: anchored ? c.moss50 : Colors.transparent,
            border: Border.all(
              color: anchored ? c.moss200 : Colors.transparent,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    label,
                    style: jpStyle(
                      size: 11,
                      weight: FontWeight.w800,
                      color: c.ink2,
                      letterSpacing: 0.08 * 11,
                    ),
                  ),
                  if (anchored) ...[
                    const SizedBox(width: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      decoration: BoxDecoration(
                        color: c.moss200,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        '固定',
                        style: jpStyle(
                          size: 9,
                          weight: FontWeight.w700,
                          color: c.moss700,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              if (date != null) ...[
                const SizedBox(height: 2),
                Text(
                  date!,
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w700,
                    color: c.moss700,
                  ),
                ),
              ],
              const SizedBox(height: 1),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    time,
                    style: numStyle(
                      size: 21,
                      weight: FontWeight.w500,
                      color: c.ink,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      sub,
                      overflow: TextOverflow.ellipsis,
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w600,
                        color: c.ink2,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 週間目標の達成度リング ＋ 今日の実績を 1 枚にまとめたカード。
/// 旧「今日の統計バー」を置き換え、ストリークもここへ統合する。
class _WeeklyGoalCard extends StatelessWidget {
  const _WeeklyGoalCard({
    required this.weekKm,
    required this.todayKm,
    required this.todaySteps,
    required this.todayKcal,
    required this.streakDays,
  });

  final double weekKm;
  final double todayKm;
  final int todaySteps;
  final int todayKcal;
  final int streakDays;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    const goal = AppConstants.weeklyGoalKm;
    final pct = goal <= 0 ? 0.0 : (weekKm / goal).clamp(0.0, 1.0);

    return ArukuCard(
      key: const Key('home-weekly-goal'),
      borderRadius: 22,
      shadow: const [
        BoxShadow(
          color: ArukuTokens.shadowCardSubtle,
          blurRadius: 24,
          offset: Offset(0, 8),
        ),
      ],
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      child: Row(
        children: [
          // 達成度リング
          SizedBox(
            width: 64,
            height: 64,
            child: CustomPaint(
              painter: _GoalRingPainter(
                pct: pct,
                track: c.moss100,
                progress: c.moss500,
              ),
              child: Center(
                child: Text(
                  '${(pct * 100).round()}%',
                  style: numStyle(
                    size: 14,
                    weight: FontWeight.w600,
                    color: c.moss700,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '今週の目標 ${_fmtKm(goal)}km',
                  style: jpStyle(
                    size: 13,
                    weight: FontWeight.w800,
                    color: c.ink2,
                    letterSpacing: 0.08 * 13,
                  ),
                ),
                const SizedBox(height: 2),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      weekKm.toStringAsFixed(1),
                      style: numStyle(
                        size: 24,
                        weight: FontWeight.w600,
                        color: c.ink,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      'km',
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w700,
                        color: c.ink2,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                _TodayLine(
                  todayKm: todayKm,
                  todaySteps: todaySteps,
                  todayKcal: todayKcal,
                  streakDays: streakDays,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 「今日 Xkm · Y歩 · Zkcal · 🔥N日連続」の行。狭幅では折り返す。
class _TodayLine extends StatelessWidget {
  const _TodayLine({
    required this.todayKm,
    required this.todaySteps,
    required this.todayKcal,
    required this.streakDays,
  });

  final double todayKm;
  final int todaySteps;
  final int todayKcal;
  final int streakDays;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final labelStyle = jpStyle(
      size: 13,
      weight: FontWeight.w600,
      color: c.ink2,
    );
    final numberStyle = numStyle(
      size: 13,
      weight: FontWeight.w700,
      color: c.ink2,
    );
    Text t(String s, {bool number = false}) =>
        Text(s, style: number ? numberStyle : labelStyle);

    return Wrap(
      spacing: 4,
      runSpacing: 2,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        t('今日'),
        t(todayKm.toStringAsFixed(1), number: true),
        t('km ·'),
        t(_fmtInt(todaySteps), number: true),
        t('歩 ·'),
        t('$todayKcal', number: true),
        t('kcal'),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Ic.fire(size: 12, color: c.burnt),
            const SizedBox(width: 3),
            Text(
              '$streakDays日連続',
              style: jpStyle(size: 13, weight: FontWeight.w800, color: c.burnt),
            ),
          ],
        ),
      ],
    );
  }
}

/// リングの達成度を描画する。-90° 始点で時計回りに `pct` ぶん塗る。
class _GoalRingPainter extends CustomPainter {
  _GoalRingPainter({
    required this.pct,
    required this.track,
    required this.progress,
  });

  final double pct;
  final Color track;
  final Color progress;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 7.0;
    final center = size.center(Offset.zero);
    final radius = (size.shortestSide - stroke) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);

    final trackPaint = Paint()
      ..color = track
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    canvas.drawCircle(center, radius, trackPaint);

    if (pct <= 0) return;
    final progressPaint = Paint()
      ..color = progress
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    const start = -math.pi / 2; // -90°
    canvas.drawArc(rect, start, 2 * math.pi * pct, false, progressPaint);
  }

  @override
  bool shouldRepaint(_GoalRingPainter old) =>
      old.pct != pct || old.track != track || old.progress != progress;
}

class _SearchCTA extends StatelessWidget {
  const _SearchCTA({required this.hasDestination, required this.onPressed});
  final bool hasDestination;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuButton(
      label: hasDestination ? 'ルートを検索' : '目的地を選ぶ',
      onPressed: onPressed,
      icon: hasDestination
          ? Ic.routes(size: 20, color: c.ivory)
          : Ic.search(size: 19, color: c.ivory),
      height: 60,
      borderRadius: 20,
      shadow: const [
        BoxShadow(
          color: ArukuTokens.shadowCtaPrimary,
          blurRadius: 28,
          offset: Offset(0, 10),
        ),
      ],
      textStyle: jpStyle(
        size: 18,
        weight: FontWeight.w800,
        color: c.ivory,
        letterSpacing: 0.06 * 18,
      ),
    );
  }
}

/// 整数を 3 桁区切りで整形する（例: 2000 → "2,000"）。
String _fmtInt(int n) {
  final s = n.abs().toString();
  final buf = StringBuffer(n < 0 ? '-' : '');
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
    buf.write(s[i]);
  }
  return buf.toString();
}

/// 週間目標距離を整形する（整数なら小数点を省く）。
String _fmtKm(double km) =>
    km == km.roundToDouble() ? km.toStringAsFixed(0) : km.toStringAsFixed(1);
