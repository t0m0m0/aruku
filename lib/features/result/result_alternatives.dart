part of 'result_screen.dart';

/// パレート非劣解の代替案セクション（#290）。0件なら何も描画しない。
class _AlternativesSection extends StatelessWidget {
  const _AlternativesSection({
    required this.alternatives,
    required this.onSelect,
  });

  final List<RoutePlan> alternatives;
  final void Function(int index) onSelect;

  @override
  Widget build(BuildContext context) {
    if (alternatives.isEmpty) return const SizedBox.shrink();
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.resultAlternativesTitle,
            style: jpStyle(
              size: 11,
              weight: FontWeight.w800,
              color: c.ink3,
              letterSpacing: 0.4,
            ),
          ),
          const SizedBox(height: 8),
          for (var i = 0; i < alternatives.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            _AlternativeCard(route: alternatives[i], onTap: () => onSelect(i)),
          ],
        ],
      ),
    );
  }
}

class _AlternativeCard extends StatelessWidget {
  const _AlternativeCard({required this.route, required this.onTap});

  final RoutePlan route;
  final VoidCallback onTap;

  int get _walkMinutes => route.segments
      .where((s) => s.type == SegmentType.walk)
      .fold(0, (sum, s) => sum + s.minutes);

  /// 到着表示は「最終区間の実測 arrTime」→「timelineNodes 最終ノード」→
  /// 「所要分からの相対表記」の順にフォールバックする（#290）。代替案には
  /// 駅名復元の追加照会をかけていないため、絶対時刻が欠けるケースがある。
  String _arrivalLabel(AppLocalizations l10n) {
    final lastArrTime = route.segments.isEmpty
        ? null
        : route.segments.last.arrTime;
    if (lastArrTime != null) return _formatClock(lastArrTime);
    if (route.timelineNodes.isNotEmpty) return route.timelineNodes.last.time;
    return l10n.resultAlternativeArrivalFallback(route.totalMin);
  }

  String _formatClock(DateTime t) =>
      '${t.hour}:${t.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final summary = l10n.resultAlternativeSummary(
      _walkMinutes,
      _arrivalLabel(l10n),
      route.transferCount,
    );
    return Semantics(
      button: true,
      label: summary,
      child: Material(
        color: c.paper,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: c.hairline),
            ),
            child: Row(
              children: [
                Expanded(
                  child: ExcludeSemantics(
                    child: Text(
                      summary,
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w700,
                        color: c.ink,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Ic.chevron(size: 14, color: c.ink3, dir: ChevronDir.right),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
