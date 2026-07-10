import 'package:flutter/foundation.dart';

import '../models/route_plan.dart';
import 'hybrid_route_selector.dart';
import 'route_plan_builder.dart';

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
  const RouteDiagnostics({bool verbose = kDebugMode}) : _verbose = verbose;

  final bool _verbose;

  /// 選定ログ1行を `[route]` プレフィックス付きで出す（[_verbose] が真のときのみ）。
  ///
  /// メッセージは遅延ビルダ（`String Function()`）で受け取る。[_verbose] が偽の
  /// リリースビルドではクロージャを評価せず、高コストな文字列構築を一切行わない（#164）。
  /// 引数を eager 評価する `void log(String)` では、ガードが効く前にコストを払っていた。
  void log(String Function() build) {
    if (_verbose) debugPrint('[route] ${build()}');
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
