import 'package:flutter/foundation.dart';

import '../models/route_plan.dart';
import 'hybrid_route_selector.dart';
import 'route_plan_builder.dart';

/// 1検索分の定量指標（#309）。collapse 発火・board-search 起動・上流 HTTP 往復本数・
/// フェーズ別所要時間を1オブジェクトに集約し、[toLogLine] で機械集計可能な1行に整形する。
///
/// 定性ログ（[RouteDiagnostics.log]）が「なぜこの候補が勝ったか」を人間向けに追うのに対し、
/// これは「発火率・本数・所要」を実機ログから grep で集計するための定量出力（#309 の狙い）。
/// 可変（アキュムレータ）なのは、選定が複数フェーズ・並列 IO にまたがり値が後から確定する
/// ため。1インスタンス＝1検索の寿命で、[TransitRouteService.plan] が生成・充填・出力する。
class RouteSearchMetrics {
  /// 崩壊判定（`_isCollapse`）が true になったか（board-search を試みる契機）。
  bool collapseFired = false;

  /// board-search フォールバックが実際に候補を引きに走ったか。
  bool boardSearchActivated = false;

  /// 初回 `/guidance/plan`（必須の1本）に掛かった実時間（ミリ秒）。
  int guidanceMs = 0;

  /// board-search フォールバック区間の実時間（起動しなければ 0）。
  int boardSearchMs = 0;

  /// 確定候補の駅名確定（`_finalizeStationNames`）に掛かった実時間。
  int finalizeMs = 0;

  /// `plan` 入口〜確定までの全体実時間。
  int totalMs = 0;

  /// `/guidance/plan` の実 HTTP 往復本数（初回＋引き直し）。
  int guidanceCalls = 0;

  /// Google 徒歩ルート（enrich）の実 HTTP 往復本数。
  int walkCalls = 0;

  /// Google 徒歩マトリクスの実 HTTP 往復本数。
  int matrixCalls = 0;

  /// 1検索あたりの上流 HTTP 往復本数の実測（全種別の合計）。
  int get httpRoundTrips => guidanceCalls + walkCalls + matrixCalls;

  /// grep で機械集計できる安定した key=value 1行に整形する。bool は割合を出しやすいよう
  /// 0/1 に落とす（`grep 'collapse=1' | wc -l` で発火数、総数で割れば発火率）。
  String toLogLine() =>
      'collapse=${collapseFired ? 1 : 0} '
      'boardSearch=${boardSearchActivated ? 1 : 0} '
      'http=$httpRoundTrips '
      'guidanceCalls=$guidanceCalls walkCalls=$walkCalls matrixCalls=$matrixCalls '
      'guidanceMs=$guidanceMs boardSearchMs=$boardSearchMs '
      'finalizeMs=$finalizeMs totalMs=$totalMs';
}

/// 経路選定（[TransitRouteService]）の診断ログ整形を担う。本質的なロジックから
/// ログ整形の関心事を切り離し、選定コードの可読性を上げる（#169）。
///
/// `verbose` が偽（リリースビルド）のとき [log] は一切評価しない。ログ本文は遅延
/// ビルダ（`String Function()`）で受け取り、`candLine` 等の高コストな文字列構築・
/// 再計算（`arrivalMinutes`/`firstMissedTransit`/`maxBoardingWait`）をクロージャ本体に
/// 閉じ込めることで、リリースビルドではコストを一切払わない（#164）。
///
/// 整形メソッド（[segSummary]/[candLine]/[boardingStationOf]）は純粋関数なので
/// `verbose` に依らず常に評価でき、単体テストで挙動を固定できる。
class RouteDiagnostics {
  /// [verbose] が真のときだけ [log] が `[route]` プレフィックス付きで出力する。既定は
  /// [kDebugMode]。debugPrint はリリースビルドでも出力されるため、`kDebugMode` から
  /// 導出してリリースビルドでは無効化する（#153）。
  ///
  /// [metricsEnabled] は [logMetrics]（定量指標）を出すかを別に握る。既定は `!kReleaseMode`
  /// ＝ debug に加え **profile でも出す**。定性ログ（[verbose]）を debug 限定にするのは
  /// スパム抑制のためだが、定量指標は実機のフィールド計測（多くは profile ビルド）で集める
  /// のが目的（#309）なので、debug 専用フラグに縛らない。全ユーザーのログを汚さないよう
  /// release だけは抑制する。
  const RouteDiagnostics({
    bool verbose = kDebugMode,
    bool metricsEnabled = !kReleaseMode,
  }) : _verbose = verbose,
       _metricsEnabled = metricsEnabled;

  final bool _verbose;
  final bool _metricsEnabled;

  /// 選定ログ1行を `[route]` プレフィックス付きで出す（[_verbose] が真のときのみ）。
  ///
  /// メッセージは遅延ビルダ（`String Function()`）で受け取る。[_verbose] が偽の
  /// リリースビルドではクロージャを評価せず、高コストな文字列構築を一切行わない（#164）。
  /// 引数を eager 評価する `void log(String)` では、ガードが効く前にコストを払っていた。
  void log(String Function() build) {
    if (_verbose) debugPrint('[route] ${build()}');
  }

  /// 1検索分の定量指標（#309）を `[route-metrics]` プレフィックス付きで1行出す
  /// （[_metricsEnabled] が真のとき＝既定では release 以外）。定性ログ（[log]）と別
  /// プレフィックス・別フラグにして、profile ビルドの実機ログからも発火率・本数を
  /// `grep '\[route-metrics\]'` で切り出して集計できるようにする（debug 限定にすると
  /// フィールド計測で使う profile で一切出ない・#309 レビュー指摘）。
  void logMetrics(RouteSearchMetrics metrics) {
    if (_metricsEnabled) debugPrint('[route-metrics] ${metrics.toLogLine()}');
  }

  /// 候補の区間構成を `walk12m+蒲12_train33m+walk3m` 形式の短い文字列にする（ログ用）。
  String segSummary(RouteCandidate c) => c.segments
      .map((s) {
        final prefix = switch (s.type) {
          SegmentType.walk => 'walk',
          SegmentType.train => '${s.line ?? 'train'}_train',
          SegmentType.bus => '${s.line ?? 'bus'}_bus',
        };
        return '$prefix${s.minutes}m';
      })
      .join('+');

  /// 候補1件の診断行（ログ用）。徒歩分・実到着・余り・予算内可否・最大乗車待ち・
  /// 乗り遅れの有無・区間構成を1行に詰める。「徒歩最大が崩壊して短い乗車＋大余りが
  /// 残る」過程（#137）を候補単位で追える。
  String candLine(RouteCandidate c, int budgetMin, DateTime departureAt) {
    final arr = arrivalMinutes(c.segments, departureAt);
    final missed = firstMissedTransit(c.segments, departureAt);
    final wait = maxBoardingWait(c.segments, departureAt);
    return 'walk=${c.walkMinutes}m arr=${arr}m slack=${budgetMin - arr}m '
        'within=${arr <= budgetMin} maxWait=${wait}m '
        'missed=${missed != null} [${segSummary(c)}]';
  }

  /// 候補の最初のtransit（電車・バス）区間の乗車駅名（ログ用）。乗車駅探索でコリドー上の
  /// どの点が実際にどの駅から乗ることになるかを見て、間引きで乗れる駅を飛ばしていないかを
  /// 切り分ける（#137 診断）。transit区間が無い・駅名空なら '?'。
  String boardingStationOf(RouteCandidate c) {
    for (final s in c.segments) {
      switch (s.type) {
        case SegmentType.walk:
          continue;
        case SegmentType.train:
        case SegmentType.bus:
          return s.fromName.isEmpty ? '?' : s.fromName;
      }
    }
    return '?';
  }
}
