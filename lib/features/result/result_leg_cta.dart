part of 'result_screen.dart';

/// 現在案内中の1区間だけを Google Maps へ引き継ぐ主CTA（#305）。
/// 経路全体ではなく [leg] 単位で「歩く」「行く」を出し分け、タップ時に
/// [onLaunch] を呼んで起動可否を受け取る。起動失敗はここでバナー表示し、
/// CTA は再タップ可能なまま残す（[urlLauncherProvider] 呼び出し自体は
/// [onLaunch] の実装側＝呼び出し元に委ねる。ウィジェットは起動失敗の
/// 表示状態だけを持つ）。
class _LegCta extends StatefulWidget {
  const _LegCta({super.key, required this.leg, required this.onLaunch});

  /// 現在案内中の区間。null は全区間完了（currentLegIndex が segments 範囲外）
  /// を表し、CTA の代わりに簡素な完了表示を出す。
  final RouteSegment? leg;

  /// タップ時に呼ばれ、起動成否（true=成功）を返す。[leg] が null のときは
  /// 呼ばれないため null 許容にしている。
  final Future<bool> Function()? onLaunch;

  @override
  State<_LegCta> createState() => _LegCtaState();
}

class _LegCtaState extends State<_LegCta> {
  bool _launchFailed = false;

  Future<void> _handleTap() async {
    final onLaunch = widget.onLaunch;
    if (onLaunch == null) return;
    bool success;
    try {
      success = await onLaunch();
    } catch (_) {
      // launchUrl 実装（url_launcher）は failure を例外でも false 戻り値でも
      // 表現し得るため、両方を同じ「起動失敗」表示に丸める。
      success = false;
    }
    if (!mounted) return;
    setState(() => _launchFailed = !success);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final leg = widget.leg;

    if (leg == null) {
      return _JourneyCompleteRow(message: l10n.resultJourneyCompleteMessage);
    }

    final isWalk = leg.type == SegmentType.walk;
    final label = isWalk
        ? l10n.resultCtaWalkToDestination(leg.toName)
        : l10n.resultCtaTransitToDestination(leg.toName);
    // バス専用アイコンは未デザインのため、タイムラインカード（#249）と同じく
    // 電車アイコンを流用する。区別は下の modeCaption（路線名/バス表記）で付ける。
    final modeIcon = isWalk
        ? Ic.walk(size: 18, color: c.ink2)
        : Ic.train(size: 18, color: c.ink2);
    final modeCaption = isWalk
        ? null
        : (leg.line ??
              (leg.type == SegmentType.train
                  ? l10n.resultTrainDefaultLabel
                  : l10n.resultBusDefaultLabel));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_launchFailed)
          _LaunchFailedBanner(message: l10n.resultCtaLaunchFailed),
        if (modeCaption != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 6, left: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Ic.train(size: 13, color: c.ink3),
                const SizedBox(width: 4),
                Text(
                  modeCaption,
                  style: jpStyle(
                    size: 12,
                    weight: FontWeight.w700,
                    color: c.ink3,
                  ),
                ),
              ],
            ),
          ),
        Row(
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: c.paper,
                border: Border.all(color: c.hairline),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Center(child: modeIcon),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ArukuButton(
                label: label,
                onPressed: _handleTap,
                icon: Ic.arrowUp(size: 18, color: c.ivory),
                iconGap: 8,
                shadow: const [
                  BoxShadow(
                    color: ArukuTokens.shadowCtaResult,
                    blurRadius: 20,
                    offset: Offset(0, 8),
                  ),
                ],
                textStyle: jpStyle(
                  size: 16,
                  weight: FontWeight.w800,
                  color: c.ivory,
                  letterSpacing: 0.06 * 16,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// [_LegCta] 起動失敗時のインライン再試行可能バナー。結果画面には SnackBar
/// 用の Scaffold が無いため、[_OverBudgetBanner] と同じくウィジェットローカルの
/// 状態でカード内に表示する。
class _LaunchFailedBanner extends StatelessWidget {
  const _LaunchFailedBanner({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: c.burnt.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.burnt.withValues(alpha: 0.24)),
      ),
      child: Row(
        children: [
          Ic.close(size: 16, color: c.burnt),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: jpStyle(size: 12, weight: FontWeight.w700, color: c.ink),
            ),
          ),
        ],
      ),
    );
  }
}

/// 全区間完了時の最小表示。walkSummary/complete 画面への接続はコミット4以降の
/// スコープ外（#305）。
class _JourneyCompleteRow extends StatelessWidget {
  const _JourneyCompleteRow({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      height: 52,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: c.moss50,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: c.moss100),
      ),
      child: Text(
        message,
        style: jpStyle(size: 15, weight: FontWeight.w800, color: c.ink),
      ),
    );
  }
}
