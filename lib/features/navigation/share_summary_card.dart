import 'package:flutter/material.dart';

import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';

/// 歩行完了時に画像化して SNS 共有するサマリーカード。
///
/// 画面幅に依存させず固定幅で自己完結させることで、`RepaintBoundary` による
/// PNG 化がどの端末でも同じ見た目になるようにしている。純ウィジェットのため
/// 描画内容（距離・kcal・区間・ハッシュタグ）はウィジェットテストで検証する。
class ShareSummaryCard extends StatelessWidget {
  const ShareSummaryCard({
    super.key,
    required this.distanceKm,
    required this.kcal,
    required this.from,
    required this.to,
  });

  final double distanceKm;
  final int kcal;
  final String from;
  final String to;

  /// PNG 化時の論理サイズ（幅）。高さは内容に合わせて可変。
  static const double width = 320;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return Container(
      width: width,
      padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
      decoration: BoxDecoration(
        color: c.ivory,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: c.hairline),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Brand + headline
          Row(
            children: [
              Ic.leaf(size: 20, color: c.moss600),
              const SizedBox(width: 8),
              Text(
                l10n.completeTitle,
                style: jpStyle(size: 18, weight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
          const SizedBox(height: 20),

          // Distance — hero metric
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                distanceKm.toStringAsFixed(1),
                style: numStyle(
                  size: 56,
                  weight: FontWeight.w600,
                  color: c.ink,
                ),
              ),
              const SizedBox(width: 6),
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  'km',
                  style: jpStyle(
                    size: 18,
                    weight: FontWeight.w700,
                    color: c.ink3,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),

          // Calories
          Row(
            children: [
              Ic.fire(size: 18, color: c.burnt),
              const SizedBox(width: 6),
              Text(
                '$kcal',
                style: numStyle(
                  size: 22,
                  weight: FontWeight.w600,
                  color: c.burnt,
                ),
              ),
              const SizedBox(width: 3),
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'kcal',
                  style: jpStyle(
                    size: 12,
                    weight: FontWeight.w700,
                    color: c.burnt,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),

          // Route from → to
          Container(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
            decoration: BoxDecoration(
              color: c.paper,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    from,
                    overflow: TextOverflow.ellipsis,
                    style: jpStyle(
                      size: 13,
                      weight: FontWeight.w800,
                      color: c.ink,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Ic.chevron(size: 16, color: c.ink3, dir: ChevronDir.right),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    to,
                    textAlign: TextAlign.end,
                    overflow: TextOverflow.ellipsis,
                    style: jpStyle(
                      size: 13,
                      weight: FontWeight.w800,
                      color: c.ink,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Hashtags
          Text(
            l10n.shareCardHashtags,
            style: jpStyle(size: 12, weight: FontWeight.w700, color: c.moss600),
          ),
        ],
      ),
    );
  }
}
