import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/geo_point.dart';
import '../../core/models/journey_progress.dart';
import '../../core/models/location_state.dart';
import '../../core/models/route_plan.dart';
import '../../core/models/time_value.dart';
import '../../core/navigation/leg_handoff.dart';
import '../../core/services/share_service.dart';
import '../../core/services/url_launcher.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/extensions/route_map_overlays.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';
import '../../shared/widgets/aruku_map.dart';

part 'result_alternatives.dart';
part 'result_totals.dart';
part 'result_timeline.dart';
part 'result_leg_cta.dart';

/// ルート概要テキストを共有する。share_plus が PlatformException 等を投げても
/// `unawaited` 実行で未捕捉の非同期例外にならないよう握り、致命化させない。
/// 結果画面には SnackBar 用の Scaffold が無く、OS の共有シートを主要な
/// フィードバック面とするため、失敗は静かに無視する（クラッシュだけ防ぐ）。
Future<void> _shareRoute(
  ShareService share,
  AppLocalizations l10n,
  RoutePlan route,
) async {
  try {
    await share.shareText(
      text: l10n.resultShareText(
        route.from,
        route.to,
        route.walkKm.toStringAsFixed(1),
        route.kcal,
      ),
    );
  } catch (_) {
    // 共有失敗は非致命。詳細は上記コメント参照。
  }
}

class ResultScreen extends ConsumerWidget {
  const ResultScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final notifier = ref.read(appStateProvider.notifier);
    final state = ref.watch(appStateProvider);
    final route = state.route;
    // journey 未開始（journey == null）は index0 扱い（#305 の仕様: 途中復帰と
    // 未開始を区別せず同じ CTA を出す）。segments 範囲外は全区間完了の番兵値。
    final currentLegIndex = state.journey?.currentLegIndex ?? 0;
    final currentLeg = route == null ? null : legAt(route, currentLegIndex);
    // null は「この区間の引き継ぎ先を特定できない」＝ CTA を出せない区間（#323）。
    final currentHandoffUri = route == null
        ? null
        : buildLegHandoffUri(
            route: route,
            index: currentLegIndex,
            origin: _handoffOrigin(state, currentLegIndex),
          );

    if (route == null) {
      return Material(
        color: c.ivory,
        child: SafeArea(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  l10n.resultNoRouteMessage,
                  style: jpStyle(
                    size: 18,
                    weight: FontWeight.w800,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 16),
                Material(
                  color: c.moss600,
                  borderRadius: BorderRadius.circular(16),
                  child: InkWell(
                    onTap: () => notifier.go(Screen.search),
                    borderRadius: BorderRadius.circular(16),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 28,
                        vertical: 14,
                      ),
                      child: Text(
                        l10n.resultBackToSearch,
                        style: jpStyle(
                          size: 15,
                          weight: FontWeight.w800,
                          color: c.ivory,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

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
                    semanticLabel: l10n.commonBack,
                    child: Ic.chevron(
                      size: 18,
                      color: c.ink,
                      dir: ChevronDir.left,
                    ),
                    onTap: () => notifier.go(Screen.home),
                  ),
                  Expanded(
                    child: Center(
                      child: Text(
                        l10n.resultDepartureLabel(
                          state.departure.fullDateLabel(),
                          state.departure.format(),
                        ),
                        style: jpStyle(
                          size: 12,
                          weight: FontWeight.w700,
                          color: c.ink3,
                        ),
                      ),
                    ),
                  ),
                  _HeaderButton(
                    key: const ValueKey('result-share-button'),
                    semanticLabel: l10n.resultShareButton,
                    child: Ic.share(size: 18, color: c.ink),
                    onTap: () => unawaited(
                      _shareRoute(ref.read(shareServiceProvider), l10n, route),
                    ),
                  ),
                ],
              ),
            ),

            if (route.totalMin > route.budgetMin)
              _OverBudgetBanner(
                overMin: route.totalMin - route.budgetMin,
                onChange: () => notifier.go(Screen.home),
              ),

            // Journey card
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
                child: ArukuCard(
                  borderRadius: 24,
                  shadow: const [
                    BoxShadow(
                      color: ArukuTokens.shadowCard,
                      blurRadius: 28,
                      offset: Offset(0, 12),
                    ),
                  ],
                  padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
                  // ヘッダ／集計／タイムラインは 1 つの内側スクロールにまとめ、
                  // 主要導線の「歩く」CTA だけは常に底に固定して画面内に残す。
                  // 大きな文字倍率で上部が伸びても CTA が押し出されない。
                  child: Column(
                    children: [
                      Expanded(
                        child: SingleChildScrollView(
                          child: Column(
                            children: [
                              _RouteMapPreview(route: route),
                              const SizedBox(height: 14),
                              _JourneyHeader(route: route),
                              const SizedBox(height: 14),
                              _TotalsStrip(route: route),
                              const SizedBox(height: 12),
                              _WalkRatioRow(route: route),
                              const SizedBox(height: 14),
                              _Timeline(route: route, journey: state.journey),
                              _AlternativesSection(
                                alternatives: state.routeAlternatives,
                                onSelect: notifier.selectAlternative,
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      _LegCta(
                        // 経路または legIndex ごとに State を作り直し、区間進行だけで
                        // なく代替案の切替でも前経路の起動失敗バナーを持ち越さない。
                        key: ValueKey((route, currentLegIndex)),
                        leg: currentLeg,
                        onManualAdvance:
                            currentLeg != null &&
                                state.journey != null &&
                                // 復帰時の到着確認が手動完了を許可した区間、または
                                // geometry 欠落かつ既に handoff（起動）済みの区間のみ。
                                // まだ出発していない geometry 欠落区間を先に完了させない。
                                (state.journeyManualCompletionAvailable ||
                                    (currentLeg.polyline.isEmpty &&
                                        state.journeyCurrentLegHandedOff))
                            ? notifier.advanceCurrentLegManually
                            : null,
                        handoffUnavailable: currentHandoffUri == null,
                        onLaunch: currentLeg == null
                            ? null
                            : () async {
                                // 初回タップ（行程未開始）で失効していたら外部起動せず
                                // 経路を無効化する。redirect が画面を遷移させるため、
                                // 起動失敗ではなく true を返しバナーを出さない（#305）。
                                if (notifier.expireStaleBeforeHandoff()) {
                                  return true;
                                }
                                final uri = currentHandoffUri;
                                final expectedJourney = state.journey;
                                // 引き継ぎ先を特定できない区間は外部地図を開かない（#323）。
                                // 起動を飛ばすだけで handoff と同じ状態遷移は通す — ここを
                                // 通らないと行程開始・歩数基準・失効からの行程保護が
                                // すべて落ち、区間に入ったまま先へ進めなくなる。
                                final launched =
                                    uri == null ||
                                    await ref.read(urlLauncherProvider)(uri);
                                // 起動に成功したときだけ行程を開始する。失敗で「開始済み」
                                // にすると、以後の復帰再評価が走ってしまうため（#305）。
                                // await 中に結果画面を離れた・代替案/区間が変わった場合は、
                                // 完了した古い起動から非表示または別経路の行程を始めない。
                                if (launched) {
                                  notifier.startJourneyIfHandoffStillCurrent(
                                    expectedRoute: route,
                                    expectedJourney: expectedJourney,
                                    expectedLegIndex: currentLegIndex,
                                  );
                                }
                                return launched;
                              },
                      ),
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

class _OverBudgetBanner extends StatelessWidget {
  const _OverBudgetBanner({required this.overMin, required this.onChange});
  final int overMin;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 0, 14, 4),
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
      decoration: BoxDecoration(
        color: c.burnt.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: c.burnt.withValues(alpha: 0.24)),
      ),
      child: Row(
        children: [
          Ic.search(size: 18, color: c.burnt),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.resultOverBudgetTitle(overMin),
                  style: jpStyle(
                    size: 13,
                    weight: FontWeight.w800,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  // 予算内に間に合う経路が無いため best-effort（最短）を表示して
                  // いる状態。検索失敗のように見せず、最短経路を出している旨を伝える。
                  l10n.resultOverBudgetHint,
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w500,
                    color: c.ink3,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Material(
            color: c.burnt,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              onTap: onChange,
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                child: Text(
                  l10n.resultChangeConditions,
                  style: jpStyle(
                    size: 12,
                    weight: FontWeight.w800,
                    color: c.ivory,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _HeaderButton extends StatelessWidget {
  const _HeaderButton({
    required this.child,
    required this.onTap,
    required this.semanticLabel,
    super.key,
  });
  final Widget child;
  final VoidCallback onTap;

  /// アイコンのみのボタンのため、VoiceOver 用にラベルを必須で受け取る。
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
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
      ),
    );
  }
}

/// 経路全体を俯瞰する固定高の地図プレビュー。代替案切替で route が差し替わると
/// routeBounds も変わり、[ArukuMap] 側の自動フィット（full variant）で追従する。
class _RouteMapPreview extends StatelessWidget {
  const _RouteMapPreview({required this.route});
  final RoutePlan route;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: SizedBox(
        height: 180,
        child: ArukuMap(
          polylines: route.toPolylines(),
          markers: route.toMarkers(),
          routeBounds: route.toBounds(),
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
              Text(
                'FROM',
                style: jpStyle(
                  size: 10,
                  weight: FontWeight.w800,
                  color: c.moss600,
                  letterSpacing: 0.12 * 10,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                route.from,
                style: jpStyle(size: 16, weight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                'TO',
                style: jpStyle(
                  size: 10,
                  weight: FontWeight.w800,
                  color: c.burnt,
                  letterSpacing: 0.12 * 10,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                route.to,
                textAlign: TextAlign.end,
                style: jpStyle(size: 16, weight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 区間 CTA の Google Maps 引き継ぎ URL の origin（#305）。
/// まだ出発していない先頭区間の初回起動（journey 未開始）だけは、手動指定の出発地から
/// 検索した経路なら表示中の経路の起点（[AppState.originLatLng]）を使う。現在地に置き
/// 換えると駅・職場など計画とは別地点から始まる別経路の案内へ飛んでしまう。
/// 一度出発した後の再起動（区間途中で戻って再タップ等）は、計画起点が古びて経路の先頭へ
/// 引き戻されるため、実測の現在地（無ければ省略）を使う。
GeoPoint? _handoffOrigin(AppState state, int legIndex) {
  if (legIndex == 0 && state.journey == null && state.originLatLng != null) {
    return state.originLatLng;
  }
  return _currentOrigin(state);
}

/// 現在地の GeoPoint。GPS 確定済みの現在地を使う。手動指定の出発地
/// （[AppState.originLatLng]）は最初の検索時点の起点であり、区間が進んだ後の
/// 「現在地」としては古びるため使わない。
GeoPoint? _currentOrigin(AppState state) {
  return switch (state.locationState) {
    LocationAvailable(:final position) => position,
    _ => null,
  };
}
