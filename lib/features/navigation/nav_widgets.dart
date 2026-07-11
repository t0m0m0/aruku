part of 'nav_screen.dart';

class _NavChip extends StatelessWidget {
  const _NavChip({
    super.key,
    required this.icon,
    this.onTap,
    required this.semanticLabel,
  });
  final Widget icon;
  final VoidCallback? onTap;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: semanticLabel,
      button: true,
      child: Material(
        color: ArukuTokens.navChipSurface,
        borderRadius: BorderRadius.circular(14),
        elevation: 2,
        shadowColor: ArukuTokens.shadowChip,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: SizedBox(width: 44, height: 44, child: Center(child: icon)),
        ),
      ),
    );
  }
}

/// [maneuver] に応じた案内アイコンと、テスト識別用のキー種別。
({String key, Widget icon}) _maneuverIcon(NavManeuver? maneuver, Color color) {
  Widget arrow(double angle) => angle == 0
      ? Ic.arrowUp(size: 32, color: color)
      : Transform.rotate(
          angle: angle,
          child: Ic.arrowUp(size: 32, color: color),
        );
  return switch (maneuver) {
    NavManeuver.board || NavManeuver.alight => (
      key: 'train',
      icon: Ic.train(size: 32, color: color),
    ),
    NavManeuver.arrive => (
      key: 'arrive',
      icon: Ic.flag(size: 32, color: color),
    ),
    NavManeuver.left => (key: 'left', icon: arrow(-math.pi / 2)),
    NavManeuver.right => (key: 'right', icon: arrow(math.pi / 2)),
    NavManeuver.slightLeft => (key: 'slight-left', icon: arrow(-math.pi / 4)),
    NavManeuver.slightRight => (key: 'slight-right', icon: arrow(math.pi / 4)),
    NavManeuver.straight || null => (key: 'straight', icon: arrow(0)),
  };
}

/// [maneuver] の案内文言。乗車/下車は路線名・駅名を織り込む。
String _maneuverText(
  AppLocalizations l10n,
  NavManeuver? maneuver, {
  String? line,
  String? stationName,
}) => switch (maneuver) {
  NavManeuver.board => l10n.navManeuverBoard(
    line ?? l10n.resultTrainDefaultLabel,
  ),
  NavManeuver.alight => l10n.navManeuverAlight(
    stationName ?? l10n.navStationDefault,
  ),
  null => l10n.navManeuverStraight,
  _ => maneuverLabel(l10n, maneuver),
};

class _InstructionCard extends StatelessWidget {
  const _InstructionCard({this.guidance, this.destination});
  final NavGuidance? guidance;
  final String? destination;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final g = guidance;
    final hasNext = g?.nextManeuver != null;
    final maneuverIcon = _maneuverIcon(g?.currentManeuver, c.ivory);
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
          decoration: BoxDecoration(
            color: c.moss700,
            borderRadius: BorderRadius.circular(22),
            boxShadow: const [
              BoxShadow(
                color: ArukuTokens.shadowFloating,
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
                  color: ArukuTokens.glassWhite,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Center(
                  key: Key('nav-maneuver-icon-${maneuverIcon.key}'),
                  child: maneuverIcon.icon,
                ),
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
                        Flexible(
                          child: FittedBox(
                            fit: BoxFit.scaleDown,
                            alignment: Alignment.centerLeft,
                            child: Text(
                              g != null ? '${g.distanceToNextTurnM}' : '--',
                              style: numStyle(
                                size: 32,
                                weight: FontWeight.w500,
                                color: c.ivory,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            'm ${_maneuverText(l10n, g?.currentManeuver, line: g?.currentLine, stationName: g?.currentStationName)}',
                            style: jpStyle(
                              size: 14,
                              weight: FontWeight.w700,
                              color: c.ivory,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      destination != null
                          ? l10n.navDestinationSuffix(destination!)
                          : '--',
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
            color: ArukuTokens.navPreviewSurface,
            borderRadius: BorderRadius.vertical(bottom: Radius.circular(14)),
          ),
          child: Row(
            children: [
              Ic.chevron(
                size: 14,
                color: ArukuTokens.onMossStrong,
                dir: ChevronDir.right,
              ),
              const SizedBox(width: 8),
              Text(
                hasNext ? '${g!.distanceToNextTurnNextM}m' : '--',
                style: numStyle(
                  size: 12,
                  weight: FontWeight.w500,
                  color: ArukuTokens.onMossStrong,
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  hasNext
                      ? _maneuverText(
                          l10n,
                          g?.nextManeuver,
                          line: g?.nextLine,
                          stationName: g?.nextStationName,
                        )
                      : '--',
                  style: jpStyle(
                    size: 12,
                    weight: FontWeight.w600,
                    color: ArukuTokens.onMossStrong,
                  ),
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
            AppLocalizations.of(context).navRerouting,
            style: jpStyle(size: 13, weight: FontWeight.w700, color: c.moss700),
          ),
        ],
      ),
    );
  }
}

/// GPS/位置情報の取得に失敗している間、ナビ中に表示する警告バナー。
class _GpsLostBanner extends StatelessWidget {
  const _GpsLostBanner();

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuCard(
      borderRadius: 14,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      color: c.dangerSoft,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.gps_off, size: 16, color: c.danger),
          const SizedBox(width: 10),
          Text(
            AppLocalizations.of(context).navGpsLost,
            style: jpStyle(size: 13, weight: FontWeight.w700, color: c.danger),
          ),
        ],
      ),
    );
  }
}

/// 自動再検索に失敗し旧ルートを表示し続けている間に出す軽量バナー。
class _RerouteFailedBanner extends StatelessWidget {
  const _RerouteFailedBanner();

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuCard(
      borderRadius: 14,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      color: c.dangerSoft,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.error_outline, size: 16, color: c.danger),
          const SizedBox(width: 10),
          Text(
            AppLocalizations.of(context).navRerouteFailed,
            style: jpStyle(size: 13, weight: FontWeight.w700, color: c.danger),
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
    required this.remainingWalkKm,
    required this.arrivalTime,
    required this.consumedKcal,
    required this.onExit,
  });

  final double traveledKm;
  final double totalKm;
  final double progress;
  final double remainingKm;

  /// 残りの徒歩距離（km）。電車を含む経路では [remainingKm] より小さくなる。
  final double remainingWalkKm;
  final String? arrivalTime;
  final int? consumedKcal;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return ArukuCard(
      borderRadius: 22,
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
      shadow: const [
        BoxShadow(
          color: ArukuTokens.shadowSheet,
          blurRadius: 40,
          offset: Offset(0, 16),
        ),
      ],
      child: Column(
        children: [
          // Progress
          Row(
            children: [
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '${traveledKm.toStringAsFixed(1)} / '
                    '${totalKm.toStringAsFixed(1)} km',
                    style: numStyle(
                      size: 11,
                      weight: FontWeight.w700,
                      color: c.moss700,
                    ),
                  ),
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
              Flexible(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerRight,
                  child: Text(
                    '${(progress * 100).round()}%',
                    style: numStyle(
                      size: 11,
                      weight: FontWeight.w700,
                      color: c.ink3,
                    ),
                  ),
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
                        l10n.homeArrivalLabel,
                        style: jpStyle(
                          size: 10,
                          weight: FontWeight.w700,
                          color: c.ink3,
                          letterSpacing: 0.06 * 10,
                        ),
                      ),
                      arrivalTime != null
                          ? FittedBox(
                              fit: BoxFit.scaleDown,
                              alignment: Alignment.centerLeft,
                              child: Text(
                                arrivalTime!,
                                style: numStyle(
                                  size: 28,
                                  weight: FontWeight.w500,
                                  color: c.ink,
                                ),
                              ),
                            )
                          : _PendingFixLabel(color: c.ink3),
                    ],
                  ),
                ),
                _Sep(),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: _RemainingColumn(
                      remainingKm: remainingKm,
                      remainingWalkKm: remainingWalkKm,
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
                          l10n.navConsumedLabel,
                          style: jpStyle(
                            size: 10,
                            weight: FontWeight.w700,
                            color: c.burnt,
                            letterSpacing: 0.06 * 10,
                          ),
                        ),
                        consumedKcal != null
                            ? FittedBox(
                                fit: BoxFit.scaleDown,
                                alignment: Alignment.centerLeft,
                                child: Row(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.baseline,
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
                              )
                            : _PendingFixLabel(color: c.ink3),
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
            label: l10n.navExit,
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

/// 下部バーの「残り」欄。電車区間を含むルートでは徒歩残りを主表示にし、
/// 全行程残りを小さく併記する（歩行アプリの文脈で全行程距離が威圧的に
/// 見える問題への対処）。徒歩のみ・電車消化後は従来どおり単一表示に戻す。
class _RemainingColumn extends StatelessWidget {
  const _RemainingColumn({
    required this.remainingKm,
    required this.remainingWalkKm,
  });

  final double remainingKm;
  final double remainingWalkKm;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    // 50m 以上の差があるときだけ「まだ歩き以外の残りがある」とみなし2段表示。
    // 浮動小数の誤差や端数で不要に分割しないための閾値。
    final showsSplit = remainingKm - remainingWalkKm > 0.05;
    final primaryKm = showsSplit ? remainingWalkKm : remainingKm;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          showsSplit ? l10n.navRemainingWalkLabel : l10n.navRemainingLabel,
          style: jpStyle(
            size: 10,
            weight: FontWeight.w700,
            color: c.ink3,
            letterSpacing: 0.06 * 10,
          ),
        ),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                primaryKm.toStringAsFixed(1),
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
        ),
        if (showsSplit)
          Text(
            l10n.navRemainingTotalValue(remainingKm.toStringAsFixed(1)),
            style: jpStyle(size: 10, weight: FontWeight.w700, color: c.ink3),
          ),
      ],
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

/// GPS初回フィックス前、意味の異なる代替値の代わりに表示する「取得中」ラベル。
class _PendingFixLabel extends StatelessWidget {
  const _PendingFixLabel({required this.color});
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(
      AppLocalizations.of(context).navPendingFix,
      style: jpStyle(size: 16, weight: FontWeight.w700, color: color),
    );
  }
}
