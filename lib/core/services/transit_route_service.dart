import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'cancellation.dart';
import 'hybrid_route_selector.dart';
import 'route_diagnostics.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';
import 'search_deadline.dart';
import 'transit_api_client.dart';
import 'transit_plan_parser.dart';

/// 選定・enrich 検証の結果一式。[chosen] は enrich 前の選定候補（guidance 見積りのまま）、
/// [enriched] は Google 実測で確定した採用経路。
typedef _Selection = ({RouteCandidate chosen, RouteCandidate enriched});

/// Transit API（`/guidance/plan`）から、予算内で徒歩を最大化するルートを生成する
/// `RouteService`（#137）。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測だけは
/// Google Routes プロキシ（App Check）を介す。選定（measure-first・乗車駅探索・
/// best-effort 縮退）と純粋関数（[selectBestRoute]/[maxWalkBoardingIndex]/
/// [frontierStations]/[arrivalMinutes]/[buildRoutePlan]）はデータ源非依存。
///
/// データ源の制約が設計を決めている（docs/spec/route-optimization.md §2.2）：
/// - 途中停車駅を leg が持たないため、transit polyline（コリドー座標）で代替する。
///   乗車駅探索はコリドーを間引きサンプリングして `plan(X→goal)` を引き直す（§2.3）。
/// - 運賃は常に null のため表示ごと廃止。乗り遅れ再照会（#115）は乗車駅探索へ
///   一本化した——引き直し便は自己整合なので `firstMissedTransit` が立たない。
class TransitRouteService implements SearchEngine {
  TransitRouteService({
    http.Client? transitClient,
    http.Client? proxyClient,
    String? transitBaseUrl,
    String? proxyBaseUrl,
    DateTime Function()? clock,
    CancellationToken? cancellation,
    SearchDeadline deadline = const SearchDeadline.none(),
    void Function(RouteSearchMetrics)? onMetrics,
  }) : _api = TransitApiClient(
         transitClient: transitClient,
         proxyClient: proxyClient,
         transitBaseUrl: transitBaseUrl,
         proxyBaseUrl: proxyBaseUrl,
         cancellation: cancellation,
         deadline: deadline,
       ),
       _deadline = deadline,
       _clock = clock ?? DateTime.now,
       _onMetrics = onMetrics;

  /// Transit API / Google プロキシへの HTTP 通信（#169）。
  final TransitApiClient _api;
  final DateTime Function() _clock;

  /// 検索1回分の締切（#300）。超過したら**引き直しの新ラウンドを起こさない**。
  ///
  /// 引き直し（乗車駅探索・代替検証）は徒歩最大化のための改善であって、必須なのは
  /// 初期 `/guidance/plan` 1本だけ。改善は `on RouteException` → null で縮退するが、
  /// 縮退する前に1本の上限いっぱい待つため、締切で止めないと「劣化した経路を、
  /// 上限×直列ラウンド数だけ待った末に受け取る」最悪が生じる。ゲートするのは改善側
  /// だけで、必須の初期照会は締切で止めない（止めれば #300 の症状そのものへ戻る）。
  final SearchDeadline _deadline;

  /// 選定の診断ログ整形（#169）。`verbose` は既定で [kDebugMode]。
  final RouteDiagnostics _diag = const RouteDiagnostics();

  /// 1検索分の定量指標（#309）の受け取り口。既定 null（本番は [_diag] のログ出力のみ）。
  /// テストが発火率・本数を debugPrint パースなしで検証するための注入点（[plan] 完了時に
  /// 1回だけ呼ぶ）。[onProgress] と同じく副作用の観測を外へ委ねる流儀。
  final void Function(RouteSearchMetrics)? _onMetrics;

  /// 見積り予算内候補を1回の並列パスで実測する短リストの本数上限（#315）。見積りを
  /// 「勝者決定」から「実測する短リスト作り」へ降格し、この本数までを候補間並列で一括
  /// 実測して実測値から勝者を選ぶ。上限はレート制限（#161: 1検索最大13ファンアウト）
  /// に合わせる。徒歩tier 降順に測り、生存者が出た tier で打ち切るため通常はここまで測らない。
  static const int _maxMeasureShortlist = 13;

  /// 非崩壊ルートの先行実測を「見積りフロント」から「予算内短リスト全体」へ広げる（Option A・
  /// #318）発火しきい値。見積り予算内ハイブリッドがこの件数以上並ぶルートは reject 多発とみなし、
  /// 短リストを1パスで先行実測して reject 後の2パス目（実機 enrichMs ~21s の主因）を畳む。
  ///
  /// 無条件では発火させない（[prewarmFront]）：勝者が最上位 tier で即生存する標準乗換中心の
  /// ルートでも短リストを測ると guidance ファンアウトが増え、レート制限（#161: 1検索最大13）と
  /// 上流コストを食う。3 は「予算内ハイブリッドが少ない共通ケース（0〜2件）では従来の tier 段階
  /// 実測を保ち、楽観ハイブリッドが並ぶルートでだけ 2パス→1パスに畳む」境目（#318 の争点）。
  static const int _singlePassHybridThreshold = 3;

  /// アクセス徒歩を一括実測するマトリクスの片側の駅数上限（要素数課金を抑える）。
  static const int _maxMatrixSideStations = 10;

  /// 乗車駅探索フォールバックの起動しきい値（崩壊判定・§7）。
  static const int _collapseWalkMarginMin = 10;
  static const double _collapseSlackRatio = 0.4;

  /// 崩壊判定の余り条件（症状2）の絶対値しきい値（分）。予算が大きいと相対比
  /// [_collapseSlackRatio]（予算の40%）が大きくなりすぎ、絶対的には大きな余り（実機の
  /// 下北沢ケースで余り50分・別ケースで29分）でも相対閾値に届かず乗車駅探索が起動しなかった。
  /// 相対・絶対のいずれかを満たせば「予算が大きく余っている」とみなす（#137）。この分数の
  /// 余りがあれば徒歩へ転換する価値があるとみて board-search を試す（外れても余分な往復は
  /// 崩壊時の O(log n) 数回のみ）。
  static const int _collapseSlackMinutes = 20;

  /// 乗車駅探索のk分割並列探索の並列度（#163）。各ラウンドでこの数の候補点を同時評価
  /// する。上げるほどラウンド数が減り速いが、Transit API への同時リクエストと無駄撃ち
  /// （境界決定に使われない評価）が増える。1 にすると従来の直列二分探索と同じ軌道。
  ///
  /// #317 で 3→5 に拡大。崩壊時 board-search の律速はラウンド間直列 guidance（1コール
  /// 〜10s）で、壁時計 = ラウンド数 × 最遅1本。matrix プレ実測で探索範囲を予算内フロンティア
  /// （`_boardSearchScanCount`）へ刈った上で fanout を上げると、ラウンド直列を縮められる。
  /// 同時に、刈り込みで減る probe 密度を fanout が補い、非単調コリドーの「評価済み徒歩最大」
  /// （#137）の解像度を保つ。
  ///
  /// 上限を欲張らない理由は**上流の未知のレート制限**。guidance は `AppConfig.transitApiBaseUrl`
  /// への直叩きで `functions/src/rate-limiter.ts` を通らないため、我々のプロキシの 30 req/min は
  /// 掛からない（#330。この誤認が長く残っていた）。代わりに効くのは第三者 API 側の制限で、
  /// 公開されておらず実測でも 429 を観測していない＝**上限が不明**という状態。429 が「予算外」と
  /// 誤認されることは無くなった（#333 の未評価分離）が、踏み抜けば probe ぶんの候補を失い、
  /// ラウンドが全滅すれば探索はそこで打ち切られる＝**徒歩は無失敗時より短くなり得る**（UI には
  /// 出ない）。崩壊時は電車系＋バス系の 2 base が並列に走るので瞬間同時発行は fanout × 2 に
  /// なる。上げるなら先に上流の制限を実測すること。
  static const int _boardSearchFanout = 5;

  /// フロンティア t1 一括実測マトリクスの1コールあたり目的地数の上限（#317 レビュー対応）。
  /// サーバ側 `MATRIX_MAX_ELEMENTS`（`functions/src/index.ts`・25）を超えると 400 で全滅し
  /// 直線推定のみへ縮退するため、目的地をこの数以下ずつに分割して投げる（origins は 1 なので
  /// elements = 目的地数）。コリドー点は最大 [_maxCorridorStops]（60）なので分割は最大3本。
  static const int _maxScanMatrixDests = 25;

  /// 乗車駅探索のコリドー候補点の上限。gtfsShape は線路追従で頂点が密（数百）なため、
  /// 均等間引きでこの数へ絞る（§2.5）。二分探索は実測 walk で駆動するので評価回数は
  /// O(log n) のまま、候補点が密なほど境界の解像度が上がり余りが小さくなる（#137）。
  /// 旧値 25 では隣接候補が約30分徒歩も離れ、境界で徒歩を予算ぎりぎりまで詰められず
  /// 余りが残っていたため引き上げた。
  static const int _maxCorridorStops = 60;

  /// ハイブリッドの土台に据える路線ファミリ base の本数上限（#292）。単一最速1本では
  /// 別路線コリドー由来の徒歩多め候補が原理的に生成されない（限界2）ため、routeName 集合の
  /// 異なる代表を最大この本数だけ土台にする。増やすほど候補が多様化するが、`_maxMeasureShortlist`
  /// の実測試行を食い合い収束前に最短へ縮退する退行（限界3）が起きやすくなるため小さく抑える。
  static const int _maxHybridBases = 3;

  /// 複数 base をマージしたハイブリッド候補の総数上限（#292）。base を増やすと候補が増え、
  /// あるファミリの「見積り予算内・実測予算外」候補が [_maxMeasureShortlist] の試行を食い潰して
  /// 別ファミリの正当な候補を検証前に打ち切り、最短（best-effort＝最早到着）へ縮退させる退行
  /// （限界3）が起きうる。総数をここで抑え、超過時は base 間ラウンドロビンで各ファミリの
  /// 徒歩多め候補を優先的に残す（1ファミリの候補群が他ファミリを締め出さないため・#292 §3）。
  static const int _maxHybridCandidates = 40;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  }) async {
    if (!_api.hasTransitApi) throw const RouteException('NO_TRANSIT_API');
    if (origin == null) throw const RouteException('NO_ORIGIN');
    if (destinationLatLng == null) throw const RouteException('NO_DESTINATION');
    final budgetMin = budgetMinutes(departure, arrival);

    // 定量指標（#309）は plan 入口〜確定までを1オブジェクトに集約する。ZERO_RESULTS 等で
    // 途中離脱した検索は集計対象にしない——器を作るのは初回 guidance が成功した後にする。
    final metrics = RouteSearchMetrics();
    final totalSw = Stopwatch()..start();

    onProgress?.call(RoutePhase.routing);

    final departureAt = _departureDateTime(departure);
    final guidanceSw = Stopwatch()..start();
    final body = await _api.fetchGuidanceAt(
      origin,
      destinationLatLng,
      departureAt,
    );
    metrics.guidanceMs = guidanceSw.elapsedMilliseconds;
    final options = parseGuidancePlan(body);
    if (options.isEmpty) throw const RouteException('ZERO_RESULTS');

    onProgress?.call(RoutePhase.walkability);

    final plan = await _selectMeasured(
      options,
      budgetMin,
      departure,
      origin: origin,
      goal: destinationLatLng,
      onProgress: onProgress,
      fromName: originName,
      toName: destination,
      metrics: metrics,
    );

    // 上流本数は API クライアントの実測カウンタから、全体時間は Stopwatch から確定させ、
    // 1検索分の指標を1行に出す。search_request（#274）とは独立の可視化なので計上を汚さない。
    metrics
      ..totalMs = totalSw.elapsedMilliseconds
      ..guidanceCalls = _api.guidanceCalls
      ..guidanceDupCalls = _api.guidanceDupCalls
      ..walkCalls = _api.walkCalls
      ..matrixCalls = _api.matrixCalls;
    _diag.logMetrics(metrics);
    _onMetrics?.call(metrics);

    return plan;
  }

  @override
  void close() => _api.close();

  /// measure-first 選定。標準乗換・実測ハイブリッド・全徒歩を同一土俵で比較し、
  /// 採用候補を Google 実測（enrich）で検証して確定する。徒歩最大化が崩壊したときだけ
  /// 乗車駅探索（引き直し）を1本足して選び直す。
  Future<RoutePlan> _selectMeasured(
    List<TransitOption> options,
    int budgetMin,
    TimeValue departure, {
    required GeoPoint origin,
    required GeoPoint goal,
    required RouteSearchMetrics metrics,
    void Function(RoutePhase)? onProgress,
    String? fromName,
    String? toName,
  }) async {
    final departureAt = _departureDateTime(departure);
    _diag.log(
      () =>
          '=== plan start: budget=${budgetMin}m departureAt=$departureAt '
          'options=${options.length} ===',
    );
    final walkCache = _WalkLegCache();
    // enrich の臨界パスを「パス本数」と「1候補の直列段数」に分けて計上する（#318 の
    // Option A はどちらに効いているのかを実測で分けるため）。検索に1つで、先行実測・
    // tier 実測・崩壊後の再選定を通して同じ台帳へ積む。
    final enrichLedger = EnrichLatencyLedger();
    // 縮退は測定口を通らないので別台帳。実測では enrichMs の9割がここだった。
    final bestEffortLedger = BestEffortLedger();
    final measured = <String, int>{};
    // 候補の実測（enrich 徒歩＋実発車時刻解決）を identity で畳むキャッシュ。winner-phase の
    // 並列一括実測と非崩壊時の先行実測が同じ候補を二度測らないための単一の測定口（#315）。
    final enrichedCache = <RouteCandidate, RouteCandidate>{};

    // ハイブリッド候補（コリドー実測由来）の identity 集合。予算内にこれが多いほど reject 多発
    // ＝先行実測を短リスト全体へ広げる（Option A・#318。[prewarmFront]）。標準乗換・全徒歩は
    // 含めない——時刻なしハイブリッドの楽観見積り（#137）だけが reject の主因だから。
    final hybrids = <RouteCandidate>{};

    // 標準乗換候補（guidance の door-to-door をそのまま候補化）。
    final candidates = <RouteCandidate>[
      for (final o in options)
        RouteCandidate(from: o.from, to: o.to, segments: o.segments),
    ];
    for (final c in candidates) {
      _diag.log(() => 'standard: ${_diag.candLine(c, budgetMin, departureAt)}');
    }

    // 単一最速ではなく路線ファミリの異なる複数 base を土台にする（#292・限界2）。増分 API
    // コストはゼロ（取得済み options を追加で使うだけ）。base ごとのハイブリッドは構造
    // フィンガープリント（[_hybridKey]）でマージ重複除去し、多様化が実測試行を食い合って
    // 最短へ縮退する退行（限界3）を抑える。`measured` は base 間で共有し同一レッグの再計測を畳む。
    final bases = basesForHybrid(options);
    // 崩壊時の board-search は単一 base を土台にする（#137）。先頭は総所要最小＝従来の
    // [_baseForHybrid] と一致するため、崩壊フォールバックの挙動は #292 前と変わらない。
    final base = bases.isEmpty ? null : bases.first;
    final hybridSw = Stopwatch()..start();
    if (bases.isNotEmpty) {
      _diag.log(() => 'hybrid bases: ${bases.length}家系');
      // base ごとの実測（マトリクス IO）は互いに独立なので並列に投げる（#163・Codex 指摘）。
      // 逐次だと base 数だけマトリクス往復が数珠つなぎになりユーザー体感が伸びる。`measured` は
      // 共有するが、書き込みは各 await 後に同一値で冪等なので競合しない。
      final built = await Future.wait([
        for (final b in bases)
          _buildCorridorHybrids(
            b,
            origin,
            goal,
            budgetMin,
            departureAt,
            measured,
          ),
      ]);
      final merged = mergeHybrids(
        built,
        (h) => arrivalMinutes(h.segments, departureAt) <= budgetMin,
      );
      candidates.addAll(merged);
      hybrids.addAll(merged);
      _diag.log(
        () => 'merged hybrids: ${merged.length}件（上限$_maxHybridCandidates）',
      );
    } else {
      _diag.log(() => 'no base route (corridor<2); all-walk only');
      await _measureAccessWalks(origin, goal, const [], const [], measured);
    }
    metrics.hybridMs = hybridSw.elapsedMilliseconds;

    final allWalk = _measuredWalk(
      origin,
      goal,
      options.first.from,
      options.first.to,
      measured,
    );
    candidates.add(allWalk);
    _diag.log(
      () => 'allWalk: ${_diag.candLine(allWalk, budgetMin, departureAt)}',
    );
    _diag.log(() => 'total candidates: ${candidates.length}');

    // last-resort のバス再照会は高々1回。**採用**されるのは予算内候補が出ないときだけなので、
    // 電車で間に合う通常時はバスが候補プールに混ざらない（#250）。
    List<TransitOption>? busOptions;
    List<RouteCandidate>? busCandidates;
    Future<List<TransitOption>>? busFetch;

    // 照会だけ先に始める（投機）。`giveUp` は best-effort の実測結果が出るまで採用の可否を
    // 決められないが、**照会自体はその結果に依存しない**。直列に置くと上流1本ぶんの段が
    // 丸ごと体感へ乗る（実機 12.6s）ので、判断を待たずに発行して段を重ねる。
    //
    // **ここで `busOptions` を埋めてはいけない。** `_isCollapse` の比較集合
    // （`collapseOptions`）と `_busBaseFor` は `busOptions` の非 null を「バスが土俵に
    // 乗ったか」の判定に使っている。投機で埋めると、バスが勝っていない検索でも比較集合が
    // 膨らんで `bestStandardWalk` が上がり、崩壊が不成立になって board-search が静かに
    // 抑制され得る（＝徒歩最大化の劣化）。採用は `lastResortBus` を実際に await した
    // ときだけに限る。
    void prefetchBus() {
      if (busCandidates != null || busFetch != null) return;
      busFetch = _fetchBusOptions(origin, goal, departureAt);
      // 捨てる経路（best-effort が予算内で終わる）で未処理例外にしないための番人。
      // Future は複数のリスナを持てるので、後から await する経路の例外伝播は妨げない
      // ——キャンセル（[SearchCanceledException]）を握り潰さないために必要な性質。
      busFetch!.ignore();
    }

    Future<List<RouteCandidate>> lastResortBus() async {
      if (busCandidates != null) return busCandidates!;
      prefetchBus();
      // 計上するのは**投機で覆えなかった残りの直列待ち**（発行から完了までの全体ではない）。
      // 先行発行が間に合っていれば 0 に近づき、それがこの最適化の効き目そのものになる。
      final waitSw = Stopwatch()..start();
      busOptions = await busFetch!;
      metrics.busLastResortMs = waitSw.elapsedMilliseconds;
      return busCandidates = [
        for (final o in busOptions!)
          RouteCandidate(from: o.from, to: o.to, segments: o.segments),
      ];
    }

    // 崩壊が見込まれないなら、見積りフロント（勝者＋棄却時のフォールバック候補上位）を1回の
    // 並列パスで先行実測して [enrichedCache] を温める（#315）。以降の winner-phase は
    // キャッシュヒットで純粋計算になり、勝者棄却時のフォールバック実測も**1パスに畳まれる**。
    // 崩壊が見込まれるときは温めない——board-search 後に支配される早着・徒歩少の候補へ IO を
    // 無駄撃ちしないため。判定は見積り勝者で行い、実測を
    // 待たない（崩壊判定は見積り基準なので実測なしで確定できる）。バスは last-resort（予算外時）
    // でしか出ないので、見積り予算内のこの分岐では busBase 崩壊は起こらず options だけで足りる。
    final estWinner = selectBestRoute(
      candidates: candidates,
      budgetMin: budgetMin,
      origin: origin,
      goal: goal,
      departureAt: departureAt,
    );
    final estWithin =
        arrivalMinutes(estWinner.segments, departureAt) <= budgetMin;
    final preCollapse =
        base != null &&
        estWithin &&
        _isCollapse(estWinner, options, budgetMin, departureAt);

    // 崩壊が見込まれるなら、電車系 board-search を enrich と**並行に**起動する（#341）。
    // 前倒しできる根拠は依存関係にある: [base] は guidance の map セグメントだけから決まり、
    // enrich（徒歩実測・実発車時刻解決）の出力を一切読まない。勝者確定を待っていたのは依存
    // ではなく順序の惰性で、待つと上流1本ぶんの床（実測 26.5s）が丸ごと体感へ乗る。
    //
    // **バス系（busBase）は前倒ししない。** あちらは `selected.chosen` から決まる＝enrich の
    // 出力に依存するので、勝者未確定の時点では基準コリドーがまだ存在しない。
    final trainBoardSearch = BoardSearchStats();
    // 確定候補が board-search の何ラウンド由来かを引くための同一性マップ（両系統で共有）。
    final boardSearchRoundOf = <RouteCandidate, int>{};
    var speculationAbandoned = false;
    Future<List<RouteCandidate>>? trainBoardSearchFuture;
    if (base != null && preCollapse) {
      _diag.log(() => 'preCollapse=true → 電車系 board-search を enrich と並行に投機起動');
      metrics.boardSearchSpeculated = true;
      trainBoardSearchFuture = _buildBoardSearchCandidate(
        base,
        origin,
        goal,
        budgetMin,
        departureAt,
        walkCache,
        trainBoardSearch,
        boardSearchRoundOf,
        abandoned: () => speculationAbandoned,
      );
      // 捨てる経路（collapse=false）で未処理例外にしないための番人。Future は複数のリスナを
      // 持てるので、崩壊時に await する経路の例外伝播は妨げない——キャンセル
      // （[SearchCanceledException]）を握り潰さないために必要な性質（`prefetchBus` と同型）。
      trainBoardSearchFuture.ignore();
    }

    final enrichSw = Stopwatch()..start();
    if (estWithin && !preCollapse) {
      // 先行実測の対象は [prewarmFront] が決める：予算内ハイブリッドが多い reject 多発ルートは
      // 短リスト全体を1パスで温めて reject 後の2パス目を畳み（Option A・#318）、そうでなければ
      // 従来どおり見積りフロントだけを温める（Option B・#315）。短リストは [_selectAndEnrich] の
      // tier 実測と同一の [measureShortlist] を用い、温めたキャッシュが確実にヒットするようにする。
      final shortlist = measureShortlist(
        candidates: candidates,
        budgetMin: budgetMin,
        departureAt: departureAt,
        origin: origin,
        goal: goal,
      );
      // 締切切れなら Option A の広い先行実測を許さない（#318 レビュー対応）。先行実測の徒歩
      // enrich は締切を無視する fail-open なので、締切を過ぎたのに短リスト全体を測ると使われない
      // 下位候補へ余計な上流往復を撃つ。勝者だけ温める Option B へ抑制する。
      final front = prewarmFront(
        shortlist: shortlist,
        chosen: estWinner,
        hybrids: hybrids,
        singlePassHybridThreshold: _singlePassHybridThreshold,
        maxMeasureShortlist: _maxMeasureShortlist,
        allowSinglePass: !_deadline.isExpired,
      );
      final prewarm = front.prewarm;
      metrics.singlePassMeasure = front.singlePass;
      _diag.log(
        () => front.singlePass
            ? '非崩壊: 予算内短リスト${prewarm.length}件を1パスで先行実測（#318 Option A: reject多発ルート）'
            : '非崩壊: 見積りフロント${prewarm.length}件を1パスで先行実測（#315 winner 先行実測）',
      );
      // 例外は候補単位で握る。先行実測はキャッシュ温めの最適化にすぎず、壊れた応答1件で
      // plan() 全体を落としてはならない（先行実測の enrich 失敗は確定経路をブロックしない）。
      // 握った候補は未キャッシュのまま残り、winner-phase が改めて
      // 測って各々の try/catch で処理する（勝者が壊れていれば従来どおり winner-phase で顕在化）。
      // ただしキャンセルだけは飲まない——先行実測中の離脱を握り潰すと勝者だけで完走してしまう
      // （#316: cancellation.dart のキャンセル境界を並列パスでも守る）。
      await Future.wait([
        for (final c in prewarm)
          _measureOrDrop(
            c,
            departureAt,
            walkCache,
            enrichedCache,
            enrichLedger,
          ),
      ]);
      enrichLedger.endPass();
    }
    var selected = await _selectAndEnrich(
      candidates,
      budgetMin,
      departureAt,
      origin: origin,
      goal: goal,
      walkCache: walkCache,
      enrichedCache: enrichedCache,
      enrichLedger: enrichLedger,
      bestEffortLedger: bestEffortLedger,
      lastResortBus: lastResortBus,
      prefetchBus: prefetchBus,
    );
    // 崩壊後の再選定でも enrich は走り、その費用は同じ台帳（[enrichLedger] /
    // [bestEffortLedger]）へ積まれる。ここで時計を止めっぱなしにすると、台帳が覆う区間より
    // [enrichMs] が短くなり `enrichMs − enrichCriticalMs − bestEffortMs`（計上外の残り）が
    // 負に化ける。再選定の区間だけ時計を再開し、両者の区間を一致させる（#309 レビュー指摘）。
    enrichSw.stop();

    _diag.log(
      () =>
          'selected(initial): '
          'chosen(見積り)=${_diag.candLine(selected.chosen, budgetMin, departureAt)} | '
          'enriched(実測)=${_diag.candLine(selected.enriched, budgetMin, departureAt)}',
    );

    // last-resort のバスが勝ったら、そのバス corridor も徒歩最大化の基準に据える（#251）。
    // 電車が勝った通常時は [busBase] が null のままで、#249 の train-only ガードが効き続ける。
    final busBase = _busBaseFor(selected.chosen, busCandidates, busOptions);

    // 崩壊判定は enrich 前の選定候補（[selected.chosen]）で行う。enrich 後の徒歩は
    // Google 実街路で膨らみ、標準乗換の guidance 見積り徒歩と測定基準がずれるため、
    // 両者を同じ見積り基準で比較しないと崩壊が誤って不成立になる（徒歩最大化の不達）。
    //
    // 比較集合には last-resort のバス option も含める（#251）。バスが勝つのは電車が予算内に
    // 収まらないときなので、電車 option だけを見ると `bestStandardWalk=0` になり
    // `margin=勝者の徒歩` が閾値を超えて崩壊が不成立になる。勝者自身を含む door-to-door
    // 候補群と比べてこそ「乗り通しの標準候補と同じだけしか歩いていない」を検出できる。
    final collapseOptions = busOptions == null
        ? options
        : [...options, ...busOptions!];
    final collapse =
        (base != null || busBase != null) &&
        _isCollapse(selected.chosen, collapseOptions, budgetMin, departureAt);
    metrics.collapseFired = collapse;
    if (collapse) {
      metrics.boardSearchActivated = true;
      final boardSw = Stopwatch()..start();
      _diag.log(() => 'collapse=true → board-search フォールバック起動');
      // 電車系（base）とバス系（busBase）は基準コリドーが独立なので並列に走らせる
      // （#304）。各系統は O(log corridorStops) ラウンド × Transit API を直列に積む
      // ため、逐次だと壁時計時間が2系統ぶん数珠つなぎになる。共有する [walkCache] に
      // in-flight の共有は足さない——両系統のコリドーは別路線で、レッグキー（5桁丸め）
      // が重なるのは稀・重なっても同一レッグを二重取得するだけで結果は冪等なため。
      // 2系統は並列に走るので、計上も探索ごとに分ける。1つの [metrics] を両方から
      // 触ると scanCount/best が別々の探索の値で対を成さなくなり、rounds は並列に
      // 走ったものの和になる（#332 レビュー指摘）。
      final busBoardSearch = BoardSearchStats();
      final extra = [
        for (final built in await Future.wait([
          if (base != null)
            // バスが勝ったときも電車 base の board-search は走らせる。last-resort の発火条件は
            // 「予算外**または乗り遅れ**」（#250）なので、door-to-door では乗り遅れた電車も、
            // より手前の駅から引き直せば後続便で予算内に入ることがある。電車が全滅する状況なら
            // 予算内候補は0件で [extra] に何も足さない＝プールも選定結果も変わらない。
            //
            // 投機起動済み（#341）ならその Future をそのまま待つ。ここで起こし直すと同じ
            // 探索を二重に走らせて上流本数が倍になる。
            trainBoardSearchFuture ??
                _buildBoardSearchCandidate(
                  base,
                  origin,
                  goal,
                  budgetMin,
                  departureAt,
                  walkCache,
                  trainBoardSearch,
                  boardSearchRoundOf,
                ),
          if (busBase != null)
            // バス corridor は基準になったのがここが初めてなので、途中乗降ハイブリッドも
            // ここで作る（通常照会の base と違い、事前に作る機会がなかった）。
            () async {
              _diag.log(() => 'バス corridor を基準に徒歩最大化（#251）');
              return [
                ...await _buildCorridorHybrids(
                  busBase,
                  origin,
                  goal,
                  budgetMin,
                  departureAt,
                  measured,
                ),
                ...await _buildBoardSearchCandidate(
                  busBase,
                  origin,
                  goal,
                  budgetMin,
                  departureAt,
                  walkCache,
                  busBoardSearch,
                  boardSearchRoundOf,
                ),
              ];
            }(),
        ]))
          ...built,
      ];
      metrics.recordBoardSearches([
        if (base != null) trainBoardSearch,
        if (busBase != null) busBoardSearch,
      ]);
      if (extra.isNotEmpty) {
        _diag.log(() => '徒歩最大化候補: ${extra.length}件をプールへ追加');
        // 既に引いたバス候補（あれば）も再選定のプールへ引き継ぐ。board-search 候補が
        // 逆戻り・乗り遅れ・幽霊便で全滅したとき、last-resort で見つけた予算内のバスへ
        // 戻れるようにするため（引き継がないと予算外の best-effort へ落ちる）。徒歩最大化
        // の観点では乗り通しのバスは徒歩が短いので、生き残る候補があればそちらが勝つ。
        // 再選定の enrich は [boardSearchMs] の内側で払うが、台帳の区間としては enrich
        // なので [enrichMs] にも計上する（重なりは意図的。フェーズの分割より
        // 「台帳と時計が同じ区間を覆う」ことを優先する）。
        enrichSw.start();
        selected = await _selectAndEnrich(
          [...candidates, ...?busCandidates, ...extra],
          budgetMin,
          departureAt,
          origin: origin,
          goal: goal,
          walkCache: walkCache,
          enrichedCache: enrichedCache,
          enrichLedger: enrichLedger,
          bestEffortLedger: bestEffortLedger,
          lastResortBus: lastResortBus,
          prefetchBus: prefetchBus,
        );
        enrichSw.stop();
        _diag.log(
          () =>
              'selected(after board-search): '
              '${_diag.candLine(selected.enriched, budgetMin, departureAt)}',
        );
      } else {
        _diag.log(() => '徒歩最大化候補: なし');
      }
      // 確定候補が board-search 由来かを同一性で引く。tier 実測は `chosen` にプール要素を
      // そのまま返すので保たれるが、best-effort 縮退は実時刻を当てたコピーを作るため切れる
      // ——その場合の 0 は「board-search が無駄だった」ではなく「特定不能」である
      // （[RouteSearchMetrics.boardSearchWinnerRound] の番兵定義を参照）。
      metrics.boardSearchWinnerRound = boardSearchRoundOf[selected.chosen] ?? 0;
      metrics.boardSearchMs = boardSw.elapsedMilliseconds;
    } else if (base != null || busBase != null) {
      _diag.log(() => 'collapse=false → フォールバック起動せず');
    }
    if (trainBoardSearchFuture != null && !collapse) {
      // 見込みが外れた（#341）。結果は誰も使わないので新ラウンドを起こさせない。
      // 進行中のラウンドまでは止められないが、`plan()` を抜けた直後に検索スコープの
      // クライアントが閉じられて in-flight は切れる（#259・[SearchScopedRouteService]）。
      // この打ち切りが効くのはその手前——確定経路の駅名復元（上流1往復）が走る窓。
      speculationAbandoned = true;
      _diag.log(() => '投機 board-search 空振り: collapse=false → 打ち切り');
    }

    // 崩壊後の再選定も同じ台帳へ積むので、畳むのは board-search を抜けた後。
    // [enrichMs] も同じ区間（初回選定＋再選定）を覆うよう再開・停止してある。
    metrics
      ..enrichMs = enrichSw.elapsedMilliseconds
      ..recordEnrich(enrichLedger)
      ..recordBestEffort(bestEffortLedger);

    final finalizeSw = Stopwatch()..start();
    final named = await _finalizeStationNames(selected.enriched, departureAt);
    metrics.finalizeMs = finalizeSw.elapsedMilliseconds;
    // 定性ログ（上の FINAL）は debug 限定なので、profile の計測では最終徒歩が読めない。
    // 打ち切り判断は boardSearchWalkByRound と突き合わせて行うため、同じ1行に載せる。
    metrics.finalWalkMinutes = named.walkMinutes;
    // 空振りの対価は**最後に読む**（#341）。打ち切りは新ラウンドを止めるだけなので、
    // 打ち切り時点で進行中だったラウンドの probe は駅名復元の裏で発行され終える。
    // 判断が出た瞬間に読むと、その1ラウンドぶん（最大 [_boardSearchFanout] 本）を
    // 取りこぼし、投機の費用を過小に見積もる。
    if (speculationAbandoned) {
      metrics.recordSpeculationWaste(trainBoardSearch);
      _diag.log(
        () => '投機 board-search 空振りの対価: probe ${trainBoardSearch.probes}本',
      );
    }
    _diag.log(
      () => '=== FINAL: ${_diag.candLine(named, budgetMin, departureAt)} ===',
    );

    return _build(
      named,
      departure,
      budgetMin,
      onProgress,
      fromName: fromName,
      toName: toName,
    );
  }

  /// last-resort のバス option（#250）。`avoidModes` からバスを外して door-to-door を1回だけ
  /// 引き直し、**バス区間を含む option だけ**を返す（バスを含まない option は電車のみの
  /// 主照会と重複するため捨てる）。取得失敗は空リスト＝従来どおり best-effort 縮退へ。
  ///
  /// [RouteCandidate] ではなく [TransitOption] を返すのは、コリドー座標を残して徒歩最大化の
  /// 基準（[_baseForHybrid]）に据えられるようにするため（#251）。
  Future<List<TransitOption>> _fetchBusOptions(
    GeoPoint origin,
    GeoPoint goal,
    DateTime departureAt,
  ) async {
    _diag.log(() => 'バス last-resort: avoidModes からバスを外して再照会');
    final Map<String, dynamic> body;
    try {
      body = await _api.fetchGuidanceAt(
        origin,
        goal,
        departureAt,
        allowBus: true,
      );
    } on RouteException catch (e) {
      _diag.log(() => 'バス last-resort: 再照会失敗 (${e.status})');
      return const [];
    }
    return [
      for (final o in parseGuidancePlan(body))
        if (o.segments.any((s) => s.type == SegmentType.bus)) o,
    ];
  }

  /// 確定経路の transit 区間に乗降地名が無い（コリドー座標由来の候補）ときだけ、その乗車座標
  /// →降車座標で `/guidance/plan` を1回引き直して leg の実駅名・バス停名を復元する（確定候補
  /// のみ・追加コール最小）。続けて隣接徒歩区間の端点へ地名を伝播し、タイムラインの乗車ノード
  /// （直前徒歩の toName を place に使う）と電車・バスカードに地名を出す。
  ///
  /// バス区間も対象にする（#251）。バス corridor 由来のハイブリッドは電車と同様に地名を
  /// 持たないため、train 限定のままだとバス停名が空のまま確定してしまう。
  Future<RouteCandidate> _finalizeStationNames(
    RouteCandidate chosen,
    DateTime departureAt,
  ) async {
    final segs = [...chosen.segments];
    // 区間ごとの照会は互いに独立なので並列に投げる（#304）。実時刻解決
    // （[_resolveBoardingTimes]）と違い boardAt の累積依存が無く、全区間を
    // departureAt で引くため直列にする理由がない。
    final targets = [
      for (var i = 0; i < segs.length; i++)
        if (segs[i].type != SegmentType.walk &&
            (segs[i].fromName.isEmpty || segs[i].toName.isEmpty) &&
            segs[i].polyline.length >= 2)
          i,
    ];
    final fetched = await Future.wait([
      for (final i in targets)
        _fetchTransitEndpoints(
          segs[i].polyline.first,
          segs[i].polyline.last,
          departureAt,
          type: segs[i].type,
        ),
    ]);
    for (var k = 0; k < targets.length; k++) {
      final names = fetched[k];
      if (names == null) continue;
      final i = targets[k];
      segs[i] = segs[i].copyWith(
        fromName: segs[i].fromName.isEmpty ? names.from : null,
        toName: segs[i].toName.isEmpty ? names.to : null,
      );
    }
    _propagateStationNames(segs);
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segs);
  }

  /// 乗車座標 [board]→降車座標 [alight] を [at] 発で引き直し、[type] の区間を含む option の
  /// うち到着最早（[_earliestArrival]）の、先頭 [type] 区間の乗車地名・実発車時刻と、末尾
  /// [type] 区間の降車地名・実到着時刻を返す。該当 option が無い・取得失敗なら null。
  /// コリドー由来候補の駅名復元（[_finalizeStationNames]）と実時刻検証
  /// （[_resolveBoardingTimes]・approach A）で共有する。
  ///
  /// 照会モードと拾う leg の型は必ず [type] で揃える（#250）。バス区間の検証に電車のみの
  /// 照会（既定の `avoidModes=bus,...`）を使うと、返ってきた電車の駅名・時刻をバス区間へ
  /// 貼り付けてしまう。同じ理由で、応答の中の**どの option を採るか**も揃える必要がある
  /// （#343）：先頭1本を無条件に採ると、遅い便の時刻をこの区間の実時刻として貼り、乗れる
  /// 候補が乗り遅れ・予算超過に見える。
  Future<({String from, String to, DateTime? dep, DateTime? arr})?>
  _fetchTransitEndpoints(
    GeoPoint board,
    GeoPoint alight,
    DateTime at, {
    SegmentType type = SegmentType.train,
  }) async {
    final Map<String, dynamic> body;
    try {
      body = await _api.fetchGuidanceAt(
        board,
        alight,
        at,
        allowBus: type == SegmentType.bus,
      );
    } on RouteException {
      return null;
    }
    final best = _earliestArrival(
      parseGuidancePlan(
        body,
      ).where((o) => o.segments.any((s) => s.type == type)),
      at,
    );
    if (best == null) return null;
    final legs = best.segments.where((s) => s.type == type).toList();
    return (
      from: legs.first.fromName,
      to: legs.last.toName,
      dep: legs.first.depTime,
      arr: legs.last.arrTime,
    );
  }

  /// approach A（時刻なしハイブリッドの実時刻検証）。コリドー由来の電車区間は距離概算の
  /// minutes だけを持ち depTime を欠くため、乗車待ち（終電後・運行時間外の翌朝始発待ちを
  /// 含む）が [arrivalMinutes] に反映されず、走っていない電車が予算内へ化ける（#137 実機の
  /// 深夜02:41／全ハイブリッド maxWait=0m）。採用候補の時刻なし transit 区間について、乗車座標
  /// →降車座標を実 boardAt（出発＋その区間までの実累積分）で `/guidance/plan` 引き直しし、
  /// 最初の同種 leg の実発着時刻を当てる。引き直し便は boardAt 以降発の実ダイヤなので、
  /// 乗車待ち・乗車時間が実時刻で入り、深夜は始発待ちで予算外へ正しく落ちる。
  /// boardAt より前発（実ダイヤと不整合・乗れない便）・取得失敗・同種の便なしの区間は当てない。
  /// 駅名も同時に復元する（[_finalizeStationNames] の再照会を省ける）。
  ///
  /// バス区間も同じ検証に掛ける（#250）。実運用ではバス候補は door-to-door の標準乗換
  /// （実時刻付き）としてのみ入るため通常は no-op だが、時刻を欠くバス便が紛れ込んだときに
  /// 電車と同じ基準で幽霊便として弾けるようにする。
  Future<RouteCandidate> _resolveBoardingTimes(
    RouteCandidate cand,
    DateTime departureAt, {
    void Function()? onRedraw,
  }) async {
    final segs = [...cand.segments];
    var changed = false;
    for (var i = 0; i < segs.length; i++) {
      final seg = segs[i];
      if (seg.type == SegmentType.walk) continue;
      if (seg.depTime != null) continue; // 既に実時刻あり（標準乗換・board-search）
      if (seg.polyline.length < 2) continue;
      final cumBefore = arrivalMinutes(segs.sublist(0, i), departureAt);
      final boardAt = departureAt.add(Duration(minutes: cumBefore));
      // 区間間は並列化しない（#163 対象外）: 後続区間の boardAt（cumBefore）が前区間で
      // 解決した実乗車時間・乗車待ちに依存するため、直列でないと照会時刻がずれる。
      // この直列段数が enrich の壁時計を決めるので計上する（[EnrichLatencyLedger]）。
      onRedraw?.call();
      final ep = await _fetchTransitEndpoints(
        seg.polyline.first,
        seg.polyline.last,
        boardAt,
        type: seg.type,
      );
      if (ep == null || ep.dep == null || ep.dep!.isBefore(boardAt)) continue;
      final ride = (ep.arr != null && !ep.arr!.isBefore(ep.dep!))
          ? ep.arr!.difference(ep.dep!).inMinutes
          : seg.minutes;
      segs[i] = seg.copyWith(
        fromName: seg.fromName.isEmpty ? ep.from : null,
        toName: seg.toName.isEmpty ? ep.to : null,
        depTime: ep.dep,
        arrTime: ep.arr,
        minutes: ride,
      );
      changed = true;
    }
    if (!changed) return cand;
    return RouteCandidate(from: cand.from, to: cand.to, segments: segs);
  }

  /// transit 区間（電車・バス）の乗降地名を、直前（乗車側）・直後（降車側）の徒歩区間の端点が
  /// 空のときだけ写す。タイムラインの乗車ノードは直前徒歩の toName、降車後の徒歩は fromName を
  /// place に使うため。出発地・目的地の端（非空）は上書きしない。
  void _propagateStationNames(List<RouteSegment> segs) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].type == SegmentType.walk) continue;
      final board = segs[i].fromName;
      final alight = segs[i].toName;
      if (i > 0 &&
          segs[i - 1].type == SegmentType.walk &&
          segs[i - 1].toName.isEmpty &&
          board.isNotEmpty) {
        segs[i - 1] = segs[i - 1].copyWith(toName: board);
      }
      if (i + 1 < segs.length &&
          segs[i + 1].type == SegmentType.walk &&
          segs[i + 1].fromName.isEmpty &&
          alight.isNotEmpty) {
        segs[i + 1] = segs[i + 1].copyWith(fromName: alight);
      }
    }
  }

  /// 候補1件を実測（enrich 徒歩＋実発車時刻解決）し、identity でメモ化する（#315）。winner-phase の
  /// 並列一括実測・非崩壊時の先行実測が同じ候補を二度測らないための単一の
  /// 測定口。[RouteCandidate] は == を上書きしないので Map は同一インスタンス単位で畳む。
  Future<RouteCandidate> _measureCandidate(
    RouteCandidate c,
    DateTime departureAt,
    _WalkLegCache walkCache,
    Map<RouteCandidate, RouteCandidate> enrichedCache,
    EnrichLatencyLedger ledger,
  ) async {
    final hit = enrichedCache[c];
    // キャッシュヒットは壁時計を払っていないので台帳へ入れない。入れると「本数×段数」の
    // 分母が水増しされ、ファンアウトの実コストを読み違える。
    if (hit != null) return hit;
    final sw = Stopwatch()..start();
    var steps = 0;
    try {
      final e = await _resolveBoardingTimes(
        await _enrichWalkGeometry(c, walkCache),
        departureAt,
        onRedraw: () => steps++,
      );
      sw.stop();
      ledger.record(chainMs: sw.elapsedMilliseconds, resolveSteps: steps);
      return enrichedCache[c] = e;
    } on SearchCanceledException {
      // 離脱した検索の計上は無意味（[metrics] ごと捨てる）。
      rethrow;
    } catch (_) {
      // 壊れた応答で落ちる候補（[_measureOrDrop] が null にする）も、そこまでの壁時計は
      // 並列パスの待ち時間として払っている。計上しないと**上流が壊れているときほど
      // 臨界パスが小さく出る**という逆向きの歪みが入り、障害時ほど実態が読めなくなる。
      sw.stop();
      ledger.record(chainMs: sw.elapsedMilliseconds, resolveSteps: steps);
      rethrow;
    }
  }

  /// 候補**間**並列（#315）の実測を候補単位で隔離する。壊れた応答（parse 不能・プロキシ
  /// 失敗など）は null にして当該候補だけ落とすが、[SearchCanceledException] だけは飲まず
  /// 伝播させる——並列ファンアウトでキャンセルを握り潰すと、離脱後も残りの実測が走り続け
  /// plan() が停止できない（cancellation.dart）。直列版は生存者を見つけた時点で下位を測らず
  /// 壊れた候補に触れなかったので、並列化で1件の失敗が plan() 全体を巻き込まないようにする。
  Future<RouteCandidate?> _measureOrDrop(
    RouteCandidate c,
    DateTime departureAt,
    _WalkLegCache walkCache,
    Map<RouteCandidate, RouteCandidate> enrichedCache,
    EnrichLatencyLedger ledger,
  ) async {
    try {
      return await _measureCandidate(
        c,
        departureAt,
        walkCache,
        enrichedCache,
        ledger,
      );
    } on SearchCanceledException {
      rethrow;
    } catch (_) {
      return null;
    }
  }

  /// 候補から決定的に選定し、採用1経路を Google 実測（enrich）で検証する確定ループ。
  /// **乗り遅れ再照会（#115）は行わない**：実在便への差し替えはせず、
  /// enrich で (a) 予算超過、または (b) 先頭電車に乗り遅れ（標準乗換のアクセス徒歩が実街路で
  /// 伸び駅着が発車後になる・#137 副次）が判明した候補は除外して乗れる次善へ選び直す。
  /// ハイブリッド／乗車駅探索は引き直しまたは時刻なし距離概算のため `firstMissedTransit` は
  /// 構成上立たず、(b) は主に標準乗換に効く。除外しきれない（プールが1件に痩せた・試行上限）
  /// ときは確定させず best-effort へ縮退する（#254。失格した候補を素通ししない）。
  /// 戻り値の [chosen] は enrich 前の選定候補（guidance 見積り徒歩のまま）、
  /// [enriched] は採用経路を Google 実測で確定したもの。崩壊判定（[_isCollapse]）が
  /// 標準乗換と同じ見積り基準で比較できるよう、両方を返す。
  ///
  /// [lastResortBus] を渡すと、縮退した best-effort が**なお予算外か乗り遅れる**ときに限り
  /// 呼び、得られた候補をプールへ足して選定をやり直す（#250）。バス候補は素の door-to-door
  /// 候補としてプールへ混ざるだけで、逆戻りフィルタ・乗り遅れ除外・幽霊便拒否といった
  /// 既存の検証はそのまま効く。省略時はバスを引かず従来どおり縮退する（再入時がこれ）。
  /// [lastResortBus] はメモ化前提で、既にプールにあるバス候補は積み増さない。
  Future<_Selection> _selectAndEnrich(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt, {
    required GeoPoint origin,
    required GeoPoint goal,
    required _WalkLegCache walkCache,
    required Map<RouteCandidate, RouteCandidate> enrichedCache,
    required EnrichLatencyLedger enrichLedger,
    required BestEffortLedger bestEffortLedger,
    Future<List<RouteCandidate>> Function()? lastResortBus,
    void Function()? prefetchBus,
  }) async {
    /// 縮退。まず従来どおり best-effort を求め、それでも予算外ならバス許容の再照会を
    /// 一度だけ試して候補を足し、選定をやり直す（#250）。
    ///
    /// 「予算内候補なし」で即バスを引かないのは、enrich でプールの見積り予算内候補が
    /// すべて落ちた後にもこの分岐へ来るため。そこには実測で予算内に収まる標準乗換が
    /// 残っていることがあり（best-effort が拾う）、先にバスを引くと電車で間に合うケースで
    /// 追加コールが走ってしまう。判定は「best-effort が実測で使い物になるか」で行う。
    ///
    /// 「使い物になる」は到着が予算内であることに加え、乗り遅れが無いこと。[arrivalMinutes]
    /// は乗り遅れた便を「待ち0で予定どおり乗車」と楽観近似して進めるため、実測徒歩で発車後に
    /// 駅着する経路が予算内に見えてしまう。それを予算内と誤認するとバスを引かず、実際には
    /// 乗れない電車を確定してしまう（#250 レビュー指摘）。
    Future<_Selection> giveUp() async {
      // バス照会は best-effort の結果に依存しない（依存するのは採用の可否だけ）ので、
      // 判断を待たずに発行して直列の段を重ねる。予算内で終われば結果は捨てる——対価は
      // 「すでに予算内候補が実測で全滅した」縮退パスに限った guidance 1本。
      prefetchBus?.call();
      final fallback = await _bestEffortResolved(
        candidates,
        budgetMin,
        departureAt,
        walkCache,
        bestEffortLedger,
      );
      final segs = fallback.enriched.segments;
      final arrival = arrivalMinutes(segs, departureAt);
      final missed = firstMissedTransit(segs, departureAt) != null;
      _Selection fallbackSelection() =>
          (chosen: fallback.chosen, enriched: fallback.enriched);
      if (lastResortBus == null) return fallbackSelection();
      if (arrival <= budgetMin && !missed) {
        _diag.log(() => '  → best-effort が予算内(arr=${arrival}m) → バス再照会せず');
        return fallbackSelection();
      }
      final bus = await lastResortBus();
      // 再入時（バス追加後の選び直しから再び縮退したとき）に同じ候補を積み増さない。
      final fresh = [
        for (final b in bus)
          if (!candidates.any((c) => identical(c, b))) b,
      ];
      if (fresh.isEmpty) {
        _diag.log(() => '  → 追加できるバス候補なし → best-effort のまま');
        return fallbackSelection();
      }
      _diag.log(
        () =>
            '  → best-effort が'
            '${missed ? '乗り遅れ' : '予算外(arr=${arrival}m)'}'
            ' → バス候補 ${fresh.length}件をプールへ追加して選び直し（last-resort）',
      );
      return _selectAndEnrich(
        [...candidates, ...fresh],
        budgetMin,
        departureAt,
        origin: origin,
        goal: goal,
        walkCache: walkCache,
        enrichedCache: enrichedCache,
        enrichLedger: enrichLedger,
        bestEffortLedger: bestEffortLedger,
      );
    }

    // 見積り予算内候補を短リスト化（見積りを「勝者決定」から「実測する短リスト作り」へ降格）。
    // 逆戻り除外＋予算内フィルタ＋選好順（徒歩降順→実到着昇順→乗換少ない順）は先行実測
    // （Option A・#318）と同一の [measureShortlist] を用いる——両者がずれると先行実測で温めた
    // キャッシュがここでヒットせず1パスへ畳めない。
    final within = measureShortlist(
      candidates: candidates,
      budgetMin: budgetMin,
      departureAt: departureAt,
      origin: origin,
      goal: goal,
    );
    if (within.isEmpty) {
      _diag.log(() => '  → 見積り予算内候補なし → best-effort 縮退（予算外ならバス last-resort）');
      return giveUp();
    }

    // 短リストを候補**間**並列で実測する（#315）。まず最上位の徒歩tier だけを測る——[selectBestRoute]
    // は徒歩最大を勝者にするので、共通ケース（勝者が最上位 tier で即生存）はこの1バッチで済み IO 最小。
    // 最上位 tier が全滅したら、残りの見積り予算内候補（徒歩降順・短リスト上限 [_maxMeasureShortlist]
    // まで）を**1回の並列バッチ**で一括実測する。時刻なしハイブリッドは見積りが楽観で実測すると
    // 予算超過に転じやすく（#137）、1本ずつ tier を降りると reject ごとに上流 guidance が数珠つなぎ
    // になる（実機 enrichMs 24.9s の主因）。reject 時だけ残りを1ラウンドへ畳んでこれを解消する。
    // 下位候補を測るのは reject 時だけなので、勝者即確定ルートの余計な IO も、崩壊後に支配される候補
    // への無駄撃ち（#290 deferred）も避ける。勝者は徒歩最大の生存者＝直列版と一致する。
    final rejected = <RouteCandidate>{};
    final cap = within.length < _maxMeasureShortlist
        ? within.length
        : _maxMeasureShortlist;
    final firstTierWalk = within.first.walkMinutes;
    var firstTierEnd = 0;
    while (firstTierEnd < cap &&
        within[firstTierEnd].walkMinutes == firstTierWalk) {
      firstTierEnd++;
    }
    for (final range in [
      [0, firstTierEnd],
      if (firstTierEnd < cap) [firstTierEnd, cap],
    ]) {
      final batch = within.sublist(range[0], range[1]);
      _diag.log(
        () => range[0] == 0
            ? 'measure tier: walk=${firstTierWalk}m ${batch.length}件を候補間並列で実測'
            : 'reject後の残り予算内候補 ${batch.length}件を1並列バッチで一括実測（#315 B）',
      );
      // 候補単位で隔離して一括実測する。壊れた応答1件（非勝者）で Future.wait が plan()
      // 全体を落とさないよう、失敗候補は null（棄却扱い）に落とす。キャンセルだけは
      // _measureOrDrop が伝播させ、await ごと上へ抜ける（#316）。
      final enriched = await Future.wait([
        for (final c in batch)
          _measureOrDrop(
            c,
            departureAt,
            walkCache,
            enrichedCache,
            enrichLedger,
          ),
      ]);
      // tier バッチは直列に降りるので、バッチ境界＝パス境界。先行実測が温めた候補は
      // キャッシュヒットで record されないため、1パスに畳めた検索ではここが空パスになり
      // 本数に数えられない（それが Option A の恩恵の見え方）。
      enrichLedger.endPass();
      int? winnerIdx;
      for (var k = 0; k < batch.length; k++) {
        final e = enriched[k];
        if (e == null) {
          _diag.log(
            () =>
                '  → 棄却(実測失敗): ${_diag.candLine(batch[k], budgetMin, departureAt)}',
          );
          rejected.add(batch[k]);
          continue;
        }
        final v = _invariantViolation(e.segments, budgetMin, departureAt);
        if (v.overBudget || v.missed || v.unverified) {
          _diag.log(
            () =>
                '  → 棄却('
                '${v.overBudget
                    ? '予算超過'
                    : v.missed
                    ? '乗り遅れ'
                    : '未確認便'}'
                '): ${_diag.candLine(e, budgetMin, departureAt)}',
          );
          rejected.add(batch[k]);
        } else {
          // batch は選好順（徒歩降順→到着昇順）なので最初の生存者が徒歩最大＝勝者。
          winnerIdx ??= k;
        }
      }
      if (winnerIdx != null) {
        final chosen = batch[winnerIdx];
        final enrichedWinner = enriched[winnerIdx]!;
        _diag.log(
          () =>
              '  → 確定: ${_diag.candLine(enrichedWinner, budgetMin, departureAt)}',
        );
        return (chosen: chosen, enriched: enrichedWinner);
      }
    }
    // 予算内 tier をすべて測っても生存者なし（または短リスト上限）→ best-effort へ縮退する
    // （#254。実測で失格した候補をそのまま確定させない）。ここも [giveUp] を通す＝best-effort
    // が予算外のときだけバスを引く（#250）。
    _diag.log(() => '  → 予算内候補が実測で全滅 → best-effort 縮退（予算外ならバス last-resort）');
    return giveUp();
  }

  /// enrich／実時刻検証を経た区間列が確定不変条件（#254）に反しているかの3条件判定。
  /// (a) 予算超過（[arrivalMinutes] ベース）、(b) 乗り遅れ（[firstMissedTransit]）、
  /// (c) 実発車時刻を確認できない transit 区間を含む（[hasUnverifiedTransit]・#137 幻便／
  /// #250 幽霊バス）。確定経路（[_selectAndEnrich]）の検証基準の単一実装。
  ({bool overBudget, bool missed, bool unverified}) _invariantViolation(
    List<RouteSegment> segments,
    int budgetMin,
    DateTime departureAt,
  ) => (
    overBudget: arrivalMinutes(segments, departureAt) > budgetMin,
    missed: firstMissedTransit(segments, departureAt) != null,
    unverified: hasUnverifiedTransit(segments),
  );

  /// best-effort 縮退（#121／#137 深夜）。候補へ実発車時刻を当て（approach A）、引き直しでも
  /// 実時刻を確認できなかった時刻なし transit 区間を含む候補（その時間に便が無い疑い＝幻便・
  /// 幽霊バス）を除いたうえで「今夜乗れる範囲の実到着最早」を選ぶ。検証済みが皆無なら元の
  /// 解決済み候補へ戻す（全徒歩は transit を含まず常に残るため通常は空にならない）。
  ///
  /// 選んだ候補は enrich（Google 実街路の徒歩）してから**乗り遅れを測り直す**（#254）。
  /// [_bestEffort] 内の [reachableWithinBudget] は guidance 見積り徒歩に対して
  /// [firstMissedTransit] を見るため、実街路で徒歩が伸びて発車後に駅着する経路を通してしまう。
  /// 実測で乗り遅れが判明した候補は除外して選び直す。全徒歩は transit を含まず決して乗り遅れ
  /// ないので、候補に含まれる限りこのループは必ず「乗れる」候補へ収束する。
  ///
  /// ここに [_maxMeasureShortlist] のような試行上限は**置かない**。プールは毎反復 `identical` で
  /// 厳密に1件減るため停止性は `pool.length` が保証しており、上限は「全徒歩へ到達する前に
  /// 打ち切って乗り遅れ経路を返す」＝この修正が拠って立つ不変条件を壊す方向にしか働かない。
  /// enrich の IO も [walkCache] が同一レッグを1回に畳むため候補数に対して線形以下に収まる。
  ///
  /// 見積りの足切り（[reachableWithinBudget]）はそのまま残す：enrich は候補ごとに Google を
  /// 引く IO なので、安価な見積りで落とせる候補を先に落とすほど実測の回数が減る。
  Future<({RouteCandidate chosen, RouteCandidate enriched})>
  _bestEffortResolved(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt,
    _WalkLegCache walkCache,
    BestEffortLedger ledger,
  ) async {
    ledger.enter();
    final sw = Stopwatch()..start();
    // 候補ごとの実時刻解決は互いに独立なので並列に投げる（#163）。候補内の区間ループは
    // 後続区間の boardAt が前区間の解決済み実乗車時間に依存するため直列のまま。
    // 段数は候補ごとに数え、最大を採る（このパスの臨界パスは最遅1候補で決まる）。
    final depths = List<int>.filled(candidates.length, 0);
    final resolved = await Future.wait([
      for (var i = 0; i < candidates.length; i++)
        _resolveBoardingTimes(
          candidates[i],
          departureAt,
          onRedraw: () => depths[i]++,
        ),
    ]);
    ledger.recordPool(
      candidates: candidates.length,
      resolveDepth: depths.isEmpty ? 0 : depths.reduce((a, b) => a > b ? a : b),
    );
    final verified = [
      for (final c in resolved)
        if (!hasUnverifiedTransit(c.segments)) c,
    ];
    var pool = verified.isNotEmpty ? verified : resolved;
    while (true) {
      final fallback = _bestEffort(pool, budgetMin, departureAt);
      final enriched = await _enrichWalkGeometry(fallback, walkCache);
      final missed = firstMissedTransit(enriched.segments, departureAt) != null;
      // 予算超過では除外しない：best-effort は「予算内が無いとき」の縮退先なので、超過は
      // 想定内で最早到着こそが選定基準。乗り遅れ（＝そもそも乗れない）だけを除外する。
      if (!missed || pool.length == 1) {
        if (missed) {
          _diag.log(
            () =>
                '  → best-effort: 乗り遅れない候補が尽きた（最後の1件）→ '
                'そのまま縮退: ${_diag.candLine(enriched, budgetMin, departureAt)}',
          );
        }
        ledger.addMs(sw.elapsedMilliseconds);
        return (chosen: fallback, enriched: enriched);
      }
      _diag.log(
        () =>
            '  → best-effort: enrich実測で乗り遅れ→除外して選び直し: '
            '${_diag.candLine(enriched, budgetMin, departureAt)}',
      );
      ledger.recordRetry();
      pool = pool.where((c) => !identical(c, fallback)).toList();
    }
  }

  /// 予算内候補が無いときの縮退先（#121）。「今夜乗れる」範囲の実到着最早を返す。
  RouteCandidate _bestEffort(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt,
  ) {
    final pool =
        reachableWithinBudget(candidates, budgetMin, departureAt) ?? candidates;
    return pool.reduce(
      (a, b) =>
          arrivalMinutes(a.segments, departureAt) <=
              arrivalMinutes(b.segments, departureAt)
          ? a
          : b,
    );
  }

  /// 確定 [winner] が徒歩最大化の崩壊（§7）かを判定する。(1) 予算内標準乗換の最大徒歩を
  /// [_collapseWalkMarginMin] 以下しか上回らない、(2) 予算を相対（[_collapseSlackRatio]）
  /// または絶対（[_collapseSlackMinutes]）のいずれかの閾値以上余らせている、の両方を満たす
  /// とき true。best-effort（予算外）は対象外。
  ///
  /// [options] は「[winner] が属する door-to-door 候補群」を渡す（#251）。last-resort の
  /// バスが勝ったときは電車 option に加えバス option も含める。含めないと予算内の電車が
  /// 無い状況で `bestStandardWalk=0` となり、バスのアクセス徒歩がそのまま margin になって
  /// 崩壊が不成立になる＝バスに乗り通したまま予算を余らせる。閾値は変えない。
  bool _isCollapse(
    RouteCandidate winner,
    List<TransitOption> options,
    int budgetMin,
    DateTime departureAt,
  ) {
    final arrival = arrivalMinutes(winner.segments, departureAt);
    if (arrival > budgetMin) {
      _diag.log(
        () => 'collapse判定: 予算外(arr=${arrival}m>budget=${budgetMin}m)→対象外',
      );
      return false;
    }
    final slack = budgetMin - arrival;
    final relativeThreshold = budgetMin * _collapseSlackRatio;
    // 相対（予算の割合）・絶対（分）のいずれかを満たせば「予算が大きく余っている」。
    if (slack < relativeThreshold && slack < _collapseSlackMinutes) {
      _diag.log(
        () =>
            'collapse判定: 症状(2)未達 slack=${slack}m < '
            '相対閾値=${relativeThreshold.toStringAsFixed(1)}m'
            '(=${budgetMin}m×$_collapseSlackRatio) かつ < '
            '絶対閾値=${_collapseSlackMinutes}m →起動せず',
      );
      return false;
    }
    var bestStandardWalk = 0;
    for (final o in options) {
      final c = RouteCandidate(from: o.from, to: o.to, segments: o.segments);
      if (arrivalMinutes(c.segments, departureAt) <= budgetMin &&
          c.walkMinutes > bestStandardWalk) {
        bestStandardWalk = c.walkMinutes;
      }
    }
    final margin = winner.walkMinutes - bestStandardWalk;
    final result = margin <= _collapseWalkMarginMin;
    _diag.log(
      () =>
          'collapse判定: slack=${slack}m(≥閾値) '
          'winnerWalk=${winner.walkMinutes}m bestStandardWalk=${bestStandardWalk}m '
          'margin=${margin}m ${result ? '≤' : '>'} $_collapseWalkMarginMin '
          '→症状(1)=${result ? '達' : '未達'} → collapse=$result',
    );
    return result;
  }

  /// 乗車駅探索（docs/spec/route-optimization.md §3.6 / §2.3）。
  /// [base] のコリドー座標を乗車駅候補（前半徒歩 t1 の昇順）とし、各点 X から
  /// `/guidance/plan(X→goal, departureAt+t1)` を引き直して「到着が予算内の最遠＝総徒歩
  /// 最大」を [maxWalkBoardingIndexParallel]（k分割並列探索・#163）で探索する。各ラウンド
  /// [_boardSearchFanout] 点を同時評価して Transit API レイテンシの直列積み上げを避ける。
  /// 評価点の集合は直列二分探索と異なるため、戻り値の候補群も直列版と変わり得る。
  /// 引き直し便は X 発で自己整合なので `firstMissedTransit` が立たない。コリドー候補は
  /// 2未満／予算内が無いとき null。
  ///
  /// **前半徒歩は Google 実街路で実測して二分探索を駆動する（#137 主因の修正）。** 直線推定
  /// は実街路に対し大きく楽観に倒れることがあり（実機で -36分・25%）、それで二分探索を
  /// 駆動すると目的地寄りの遠い乗車駅へ収束→実街路では全部予算超過→予算内の確定に失敗して
  /// 徒歩最小の標準乗換へ崩落（大量の余り）していた。実測で駆動すれば、二分探索の各評価点は
  /// 実測で予算内可否が確定する。実測は [walkCache] 共有で、採用後の enrich でも同一レッグは
  /// キャッシュヒットし到着は覆らない。
  ///
  /// **戻り値は二分探索が評価した予算内候補を「全部」返す（#137）。** 単一の最良1本だけを返すと、
  /// それが下流の逆戻りフィルタ・乗り遅れ除外（[selectBestRoute]/[_selectAndEnrich]）で消えた
  /// とき次善の board-search 候補へ落ちられず徒歩最小へ転落する（実機: 川崎(徒歩74)が逆戻りで
  /// 弾かれ鹿島田(徒歩68)に落ちず徒歩12へ）。全候補をプールへ足せば、逆戻り・到着の非単調も
  /// 込みで「生き残る中の徒歩最大」を選定が決められる。コリドー2未満・予算内皆無は空リスト。
  Future<List<RouteCandidate>> _buildBoardSearchCandidate(
    TransitOption base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
    DateTime departureAt,
    _WalkLegCache walkCache,
    BoardSearchStats stats,
    Map<RouteCandidate, int> roundOf, {
    bool Function()? abandoned,
  }) async {
    final stops = _corridorStops(base);
    if (stops.length < 2) return const [];
    // 締切切れなら scan/probe を一切起こさず縮退する（#317 レビュー対応）。この先の探索は
    // どのみち [maxWalkBoardingIndexParallel] の shouldContinue で即打ち切られて空になるが、
    // 先頭の matrix プレ実測（proxy・deadlineApplies:false）は締切に縛られず走ってしまい、
    // 使われない改善のためだけにユーザーを待たせる。探索自体を起こさないのが正しい縮退。
    if (_deadline.isExpired) {
      _diag.log(() => 'board-search: 締切切れのため起動せず縮退');
      return const [];
    }
    // 引き直しの照会モードは基準コリドーの種別に揃える（#251）。
    final allowBus = base.segments.any((s) => s.type == SegmentType.bus);

    // #317: 全コリドー点の前半徒歩 t1 を matrix 一括実測し、t1 単独で予算外の遠点を探索範囲
    // から刈る。ラウンド間直列の guidance 引き直し（律速）を、予算内になり得る手前の点だけに
    // 絞ることでラウンド数を減らす。刈っても予算内候補は落ちない（[walkFeasiblePrefixCount] の
    // 安全上界）。
    final scanCount = await _boardSearchScanCount(origin, stops, budgetMin);
    stats.scanCount = scanCount;
    if (scanCount == 0) {
      _diag.log(() => 'board-search: 予算内の乗車駅なし（t1 実測で全点予算外）');
      return const [];
    }

    // 探索が同じ index を再評価しても引き直さないようメモ化する。同一ラウンド内の
    // 評価点は重複除去済み（[maxWalkBoardingIndexParallel]）なので同時実行は衝突しない。
    final built = <int, RouteCandidate?>{};
    // 引き直しが**上流の失敗**（429・5xx・TIMEOUT）で落ちた index。`built` の null は
    // 「経路が無い」と「評価できなかった」の両方になるが、探索に対する意味は正反対
    // （前者は境界の情報・後者は情報が無いだけ）なので別に持つ（#333）。
    final unevaluated = <int>{};

    /// 評価済みで予算内だった候補の最大徒歩（見積り・分）。皆無なら 0。
    /// ラウンド境界で [BoardSearchStats.walkByRound] へ積み、「どこで頭打ちになるか」＝
    /// 打ち切ってよいラウンドを読めるようにする。
    int bestWalkSoFar() {
      var best = 0;
      for (final c in built.values) {
        if (c == null) continue;
        if (arrivalMinutes(c.segments, departureAt) > budgetMin) continue;
        if (c.walkMinutes > best) best = c.walkMinutes;
      }
      return best;
    }

    // index → 何ラウンド目の probe が作ったか。`onRound` がラウンド開始時に rounds を
    // 進めるので、probe の**開始時点**の値がそのラウンド番号になる（同一ラウンドの probe は
    // Future.wait で揃ってから次のラウンドへ進むため、途中で繰り上がらない）。
    final builtInRound = <int, int>{};
    Future<RouteCandidate?> buildAt(int i) async {
      if (built.containsKey(i)) return built[i];
      builtInRound[i] = stats.rounds;
      // 発行時点で数える。完了時に数えると、締切・キャンセル・投機の打ち切りで捨てた
      // probe が本数から漏れ、上流へ実際に払った往復を過小に見積もる。
      stats.probes++;
      final x = stops[i];
      // 前半徒歩は実測（失敗時のみ直線推定へフォールバック）。
      final walkSw = Stopwatch()..start();
      final measured = await _tryWalk(
        origin,
        x.coord,
        fromName: base.from,
        toName: '',
        cache: walkCache,
      );
      walkSw.stop();
      // 実測が落ちたら直線推定へ縮退する（挙動は従来どおり）。ただし直線は実街路に対し
      // 大きく楽観に倒れるので（#137 実機で -36分・25%）、本来予算外の点が予算内に見えて
      // 境界が奥へ動き得る。境界を「実測で確定した値」として集計へ流さないよう印を残す。
      if (measured == null) stats.probeFailed = true;
      final walk1 =
          measured ??
          _estimateWalk(origin, x.coord, fromName: base.from, toName: '');
      final boardAt = departureAt.add(Duration(minutes: walk1.totalMin));
      final guidanceSw = Stopwatch()..start();
      final xToGoal = await _fetchTransitFrom(
        x.coord,
        goal,
        boardAt,
        allowBus: allowBus,
        onUpstreamFailure: () {
          stats.probeFailed = true;
          unevaluated.add(i);
        },
      );
      guidanceSw.stop();
      // 引き直しが失敗した probe も計上する——照会は発行され、壁時計は払っている。
      // 成否で計上を分けると「遅かったラウンド」が指標から抜け落ちる。
      stats.probeLatency.record(
        walkMs: walkSw.elapsedMilliseconds,
        guidanceMs: guidanceSw.elapsedMilliseconds,
      );
      if (xToGoal == null) {
        _diag.log(
          () =>
              'board-search i=$i walk1=${walk1.totalMin}m guidance失敗'
              '(${unevaluated.contains(i) ? '上流エラー→未評価' : '経路なし→予算外扱い'})',
        );
        return built[i] = null;
      }
      final walk1Seg = walk1.segments.first;
      final cand = RouteCandidate(
        from: base.from,
        to: xToGoal.to,
        segments: [if (walk1Seg.minutes > 0) walk1Seg, ...xToGoal.segments],
      );
      _diag.log(
        () =>
            'board-search i=$i walk1=${walk1.totalMin}m '
            '乗車駅=${_diag.boardingStationOf(cand)} '
            '${_diag.candLine(cand, budgetMin, departureAt)}',
      );
      return built[i] = cand;
    }

    // 実測到着が index 単調増の前提で「到着が予算内の最遠 index ＝総徒歩最大」を探索。
    // k分割並列版（#163）: 各ラウンドで _boardSearchFanout 点を同時評価し、Transit API
    // レイテンシ（1コール2〜10秒）の数珠つなぎを「ラウンド数×最遅1本」へ縮める。
    // 評価点の集合は直列二分探索と異なるため、プールへ足す候補（下の within）も変わり得る。
    final best = await maxWalkBoardingIndexParallel(
      // matrix プレ実測で刈った予算内フロンティアまでを探索範囲にする（#317）。
      count: scanCount,
      budgetMin: budgetMin,
      fanout: _boardSearchFanout,
      // ラウンド境界で台帳を締める。onRound はラウンド**開始時**に呼ばれるので、ここでの
      // endRound は直前のラウンドを畳む（1本目は空＝no-op）。最終ラウンドは締めない——
      // [ProbeLatencyLedger] のゲッタが進行中ぶんを含むため、締切 break でも落ちない。
      // ラウンド**開始時**に呼ばれるので、ここでの記録は直前のラウンドを締める。
      // 1本目は空（徒歩0）になるため、その1件は積まない。
      onRound: () {
        if (stats.rounds > 0) stats.walkByRound.add(bestWalkSoFar());
        stats.rounds++;
        stats.probeLatency.endRound();
      },
      // 締切超過で新ラウンドを起こさない（#300）。[TransitApiClient] の残予算クランプが
      // 既に HTTP を止めるので通信量の面では冗長だが、ゲートが無いと探索はラウンドを
      // 回し続け、全 probe が即 TIMEOUT →「予算外」と解釈されて区間を縮める——実測では
      // なく締切で境界を決めることになる。徒歩最大化の判断材料に締切を混ぜないため、
      // 探索そのものを止める。
      // 打ち切りはここでしか起きない（`lo <= hi` ＝まだ探索余地があるときにだけ
      // 呼ばれる）ので、false を返した時点が「本来もっと探せたのに止めた」瞬間になる。
      shouldContinue: () {
        // 投機起動の見込みが外れた（#341）。結果は誰も使わないので新ラウンドを起こさない
        // ——捨てると決めた探索に第三者 API の未知のレート枠（§2.1）を焼かせ続けると、
        // 同じ枠を使う次の検索の board-search が浅くなる＝徒歩が静かに短くなる。
        // [BoardSearchStats.truncated] は立てない。あれは「報告する境界が本来より手前
        // かもしれない」印だが、捨てる探索の境界はそもそも報告されない。
        if (abandoned?.call() ?? false) return false;
        if (!_deadline.isExpired) return true;
        stats.truncated = true;
        return false;
      },
      evaluate: (i) async {
        final c = await buildAt(i);
        if (c != null) return arrivalMinutes(c.segments, departureAt);
        // 引けたが経路が無い点は予算外として扱い、手前の駅を探す。上流エラーで
        // 引けなかった点は「予算外」を意味しないので未評価（null）を返す——予算外に
        // 化けさせると単調性の仮定でその先すべてが探索から外れ、境界を実測ではなく
        // レート制限が決めてしまう（#333）。
        return unevaluated.contains(i) ? null : budgetMin + (1 << 20);
      },
    );
    // 締切が**ラウンド実行中**に切れた場合、probe は TIMEOUT → 全 probe が未評価 →
    // [maxWalkBoardingIndexParallel] がそのラウンドで打ち切り、shouldContinue を再び
    // 通らずにループを抜ける。つまり「新ラウンドを起こさなかった」判定だけでは
    // 打ち切りを取りこぼす——境界を実測でなく締切が決めた、最も記録すべきケースで。
    // 自然完走の直後に切れた場合も truncated 側へ倒すが、集計は境界位置の分布から
    // 除くだけなので、取りこぼすより1件捨てる方が安全（#332 レビュー指摘）。
    if (_deadline.isExpired) stats.truncated = true;
    // 最終ラウンドぶんを締める。ここを呼び出し側の義務にすると、締切 break で抜けた
    // ——最も測りたい重い探索——で系列が1つ短くなる。
    if (stats.rounds > 0) stats.walkByRound.add(bestWalkSoFar());
    // 探索が評価した点（メモ化済み）のうち、予算内の候補を「全部」返す。境界 best 1本だけ
    // でなく全部を返すのは：(1) 到着は実街路で非単調になり得る（後方の停車駅が origin に近い等）
    // ため境界＝徒歩最大とは限らず、(2) 採用前に逆戻りフィルタ・乗り遅れ除外で1本が消えても、
    // 次善の board-search 候補へ落とせるようにするため。選定（[selectBestRoute] /
    // [_selectAndEnrich]）が逆戻り・到着の非単調を込みで「生き残る中の徒歩最大」を決める。
    final withinEntries = [
      for (final e in built.entries)
        if (e.value != null &&
            arrivalMinutes(e.value!.segments, departureAt) <= budgetMin)
          e,
    ];
    // 境界の計上は探索の戻り値ではなく**評価済みの予算内で最遠の index**。探索は最初の
    // 予算外 probe で結果の走査を打ち切るため、同一ラウンドでそれより奥に評価済みの
    // 予算内点があっても戻り値には現れない。非単調はここが明示的に扱う前提（上の
    // withinEntries が全点を返す）なので、指標だけ打ち切り側を採ると「予算内の乗車駅が
    // 探索範囲のどこに居るか」の分布が手前へ偏り、probe 配置の判断材料が歪む（#332 レビュー）。
    stats.best = withinEntries.fold(-1, (m, e) => e.key > m ? e.key : m);
    _diag.log(
      () =>
          'board-search: 実測k分割並列探索の境界 best='
          '${best == null ? 'null(予算内乗車駅なし)' : '$best'} / コリドー点${stops.length}'
          ' / 予算内最遠=${stats.best}',
    );
    final within = [for (final e in withinEntries) e.value!];
    // 確定候補がどのラウンド由来かを後から引けるようにする。RouteCandidate は == を
    // 上書きしないので Map は同一インスタンス単位で引ける（`_busBaseFor` と同じ手口）。
    for (final e in withinEntries) {
      roundOf[e.value!] = builtInRound[e.key] ?? 0;
    }
    _diag.log(() => 'board-search: 予算内候補 ${within.length}件を返す');
    return within;
  }

  /// コリドー全点の前半徒歩 t1 を matrix 一括実測し、探索を「t1 が予算内の最遠点」まで
  /// （先頭からの点数）に刈った値を返す（#317）。到着 = t1 + t2(≥0) なので t1 単独で予算外の
  /// 遠点は確実に予算外——[maxWalkBoardingIndexParallel] のラウンド間直列 guidance をそこへ
  /// 費やさない。matrix 欠落レッグは直線推定（実徒歩の下限）で埋める：下限すら予算外なら実測
  /// でも予算外なので刈って安全、下限が予算内なら刈らず探索の街路実測に委ねる。matrix は刈り
  /// 込み判定にだけ使い、採用候補の徒歩ジオメトリは従来どおり buildAt の街路実測（[_tryWalk]）
  /// が持つ。matrix 全滅時も直線推定だけで安全に刈れる（追加往復に依存しない）。
  ///
  /// 目的地はサーバの `MATRIX_MAX_ELEMENTS`（25）を超えると 400 で全滅する（→直線推定のみへ
  /// 縮退）ため、[_maxScanMatrixDests] 個以下ずつに分割し、チャンクは独立なので**並列**に投げる
  /// （直列だと proxy timeout×チャンク数まで走時計が膨らむ・#317 レビュー対応）。分割レスポンスの
  /// `destinationIndex` はチャンク内 0 起点なので、チャンク先頭を足して大域 index へ戻す。
  Future<int> _boardSearchScanCount(
    GeoPoint origin,
    List<_CorridorStop> stops,
    int budgetMin,
  ) async {
    final walk1 = [
      for (final s in stops)
        (haversineKm(origin, s.coord) * 1000 / walkMetersPerMinute).round(),
    ];
    final ranges = [
      for (var start = 0; start < stops.length; start += _maxScanMatrixDests)
        (
          start: start,
          end: start + _maxScanMatrixDests < stops.length
              ? start + _maxScanMatrixDests
              : stops.length,
        ),
    ];
    // チャンクは互いに独立なので並列に投げ、走時計を「最遅1本」に抑える（直列だと proxy の
    // timeout×チャンク数まで膨らみ、締切が近い崩壊で使えない改善のために待たせる。#317
    // レビュー対応）。[_measureAccessWalks] の乗車側／降車側マトリクスと同じ相乗り並列。
    final chunks = await Future.wait([
      for (final r in ranges)
        _api.fetchWalkMatrix(
          [origin],
          [for (var i = r.start; i < r.end; i++) stops[i].coord],
        ),
    ]);
    for (var c = 0; c < ranges.length; c++) {
      final rows = chunks[c];
      if (rows == null) continue;
      final r = ranges[c];
      for (final e in rows) {
        if (e is! Map) continue;
        final di = (e['destinationIndex'] as num?)?.toInt() ?? 0;
        final min = _parseDurationMin(e['duration']);
        if (min == null || di < 0 || di >= r.end - r.start) continue;
        walk1[r.start + di] = min;
      }
    }
    return walkFeasiblePrefixCount(walk1, budgetMin);
  }

  /// 乗降アクセス徒歩を1回（最大2コール）のマトリクス（Google プロキシ）で一括実測し、
  /// [measured] にレッグキー→徒歩分で格納する。goal を乗車側 destinations 末尾に相乗り
  /// させ全徒歩(origin→goal)も同時に測る。失敗レッグは未格納（直線推定へフォールバック）。
  Future<void> _measureAccessWalks(
    GeoPoint origin,
    GeoPoint goal,
    List<GeoPoint> boardStops,
    List<GeoPoint> alightStops,
    Map<String, int> measured,
  ) async {
    // 乗車側・降車側のマトリクスは互いに独立なので並列に投げる（#163）。
    final boardDests = [...boardStops, goal];
    final boardFuture = _api.fetchWalkMatrix([origin], boardDests);
    final alightFuture = alightStops.isEmpty
        ? Future<List<dynamic>?>.value(null)
        : _api.fetchWalkMatrix(alightStops, [goal]);
    final boardRows = await boardFuture;
    final alightRows = await alightFuture;
    if (boardRows != null) {
      for (final e in boardRows) {
        if (e is! Map) continue;
        final di = (e['destinationIndex'] as num?)?.toInt() ?? 0;
        final min = _parseDurationMin(e['duration']);
        if (min == null || di < 0 || di >= boardDests.length) continue;
        measured[_walkCacheKey(origin, boardDests[di])] = min;
      }
    }
    if (alightRows != null) {
      for (final e in alightRows) {
        if (e is! Map) continue;
        final oi = (e['originIndex'] as num?)?.toInt() ?? 0;
        final min = _parseDurationMin(e['duration']);
        if (min == null || oi < 0 || oi >= alightStops.length) continue;
        measured[_walkCacheKey(alightStops[oi], goal)] = min;
      }
    }
  }

  /// [base] のコリドーからフロンティアを絞り、アクセス徒歩を一括実測してハイブリッド候補を
  /// 作る（途中乗降＝徒歩最大化の主経路）。[measured] は呼び出し間で共有し、全徒歩
  /// (origin→goal) のレッグもここで測る。
  Future<List<RouteCandidate>> _buildCorridorHybrids(
    TransitOption base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
    DateTime departureAt,
    Map<String, int> measured,
  ) async {
    final stops = _corridorStops(base);
    final frontier = frontierStations(
      [for (final s in stops) s.coord],
      origin,
      goal,
      budgetMin,
      maxPerSide: _maxMatrixSideStations,
    );
    final baseMin = base.segments.fold(0, (a, s) => a + s.minutes);
    _diag.log(
      () =>
          'base route: totalMin=${baseMin}m corridorStops=${stops.length} '
          'frontier.boarding=${frontier.boarding} '
          'alighting=${frontier.alighting}',
    );
    await _measureAccessWalks(
      origin,
      goal,
      [for (final i in frontier.boarding) stops[i].coord],
      [for (final i in frontier.alighting) stops[i].coord],
      measured,
    );
    _diag.log(
      () =>
          'measured ${measured.length} legs; '
          'allWalk(origin->goal)=${measured[_walkCacheKey(origin, goal)]}m '
          '(null=matrix失敗→直線推定へ)',
    );
    final hybrids = _buildMeasuredHybrids(
      base,
      stops,
      frontier,
      measured,
      origin,
      goal,
    );
    _diag.log(() => 'built ${hybrids.length} hybrids:');
    for (final c in hybrids) {
      _diag.log(() => '  hybrid: ${_diag.candLine(c, budgetMin, departureAt)}');
    }
    return hybrids;
  }

  /// フロンティアの乗車駅 b → 降車駅 a（同一コリドー・b より後方）の分割を、実測アクセス
  /// 徒歩で候補化する。コリドー座標は時刻を持たないため乗車時間は折れ線長から距離概算
  /// （#67 と同じ untimed 経路）、運賃は取得不可のため null（§5）。
  List<RouteCandidate> _buildMeasuredHybrids(
    TransitOption base,
    List<_CorridorStop> stops,
    ({List<int> boarding, List<int> alighting}) frontier,
    Map<String, int> measured,
    GeoPoint origin,
    GeoPoint goal,
  ) {
    final result = <RouteCandidate>[];
    for (final b in frontier.boarding) {
      final walk1 = _measuredWalkSeg(
        origin,
        stops[b].coord,
        base.from,
        stops[b].name,
        measured,
      );
      for (final a in frontier.alighting) {
        if (a <= b) continue;
        // 乗換をまたぐ b→a は単一乗車として表現できないため同一コリドーのみ。
        if (stops[a].section != stops[b].section) continue;
        final rideKm = _railKm(stops, b, a);
        // バス corridor でも [trainMetersPerMinute] のまま概算する（#251）。実効速度は
        // バスの方が遅いが、見積りは楽観側に倒すのが選定の不変条件（§6・[walkMetersPerMinute]
        // の docstring）。enrich／実時刻検証は「見積りで予算内の候補」を落とす方向にしか
        // 働かないため、実速度で厳しく見積もると実ダイヤなら間に合うバスを選定段階で捨てて
        // しまい回収できない。乗車時間は採用前に [_resolveBoardingTimes] が実時刻で上書きする。
        final ride = (rideKm * 1000 / trainMetersPerMinute).round();
        if (ride < 0) continue;
        final walk2 = _measuredWalkSeg(
          stops[a].coord,
          goal,
          stops[a].name,
          base.to,
          measured,
        );
        result.add(
          RouteCandidate(
            from: base.from,
            to: base.to,
            segments: <RouteSegment>[
              if (walk1.minutes > 0) walk1,
              RouteSegment(
                type: stops[b].type,
                fromName: stops[b].name,
                toName: stops[a].name,
                minutes: ride,
                km: rideKm,
                line: stops[b].line,
                stops: a - b,
                polyline: [for (var i = b; i <= a; i++) stops[i].coord],
              ),
              if (walk2.minutes > 0) walk2,
            ],
          ),
        );
      }
    }
    return result;
  }

  /// 徒歩区間 [a]→[b] を実測分（[measured] にあれば）で、無ければ直線推定で作る。
  RouteSegment _measuredWalkSeg(
    GeoPoint a,
    GeoPoint b,
    String fromName,
    String toName,
    Map<String, int> measured,
  ) {
    final est = _estimateWalk(
      a,
      b,
      fromName: fromName,
      toName: toName,
    ).segments.first;
    final min = measured[_walkCacheKey(a, b)];
    if (min == null || est.minutes == 0) return est;
    return RouteSegment(
      type: SegmentType.walk,
      fromName: fromName,
      toName: toName,
      minutes: min,
      km: est.km,
      kcal: est.kcal,
      polyline: est.polyline,
    );
  }

  /// 全徒歩候補を実測分（無ければ直線推定）で作る。
  RouteCandidate _measuredWalk(
    GeoPoint origin,
    GeoPoint goal,
    String fromName,
    String toName,
    Map<String, int> measured,
  ) => RouteCandidate(
    from: fromName,
    to: toName,
    segments: [_measuredWalkSeg(origin, goal, fromName, toName, measured)],
  );

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要・距離で上書きする。
  /// 取得失敗時は元（guidance の polyline / 直線）を保つ。
  Future<RouteCandidate> _enrichWalkGeometry(
    RouteCandidate chosen,
    _WalkLegCache cache,
  ) async {
    // 徒歩区間の実測は互いに独立なので並列に投げる（#163）。取得失敗（null）は
    // 従来どおり元の区間を保つ。
    final segments = await Future.wait([
      for (final seg in chosen.segments)
        if (seg.type != SegmentType.walk || seg.polyline.length < 2)
          Future.value(seg)
        else
          _tryWalk(
            seg.polyline.first,
            seg.polyline.last,
            fromName: seg.fromName,
            toName: seg.toName,
            cache: cache,
          ).then((walk) => walk?.segments.first ?? seg),
    ]);
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segments);
  }

  RoutePlan _build(
    RouteCandidate chosen,
    TimeValue departure,
    int budgetMin,
    void Function(RoutePhase)? onProgress, {
    String? fromName,
    String? toName,
  }) {
    onProgress?.call(RoutePhase.building);
    final departureAt = _departureDateTime(departure);
    return buildRoutePlan(
      from: _displayName(fromName, chosen.from),
      to: _displayName(toName, chosen.to),
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
      departureAt: departureAt,
    );
  }

  String _displayName(String? override, String fallback) {
    final name = override?.trim();
    return (name != null && name.isNotEmpty) ? name : fallback;
  }

  /// 徒歩最大化の基準に据えるバス corridor（#251）。**勝者自身が乗っているバス便**の
  /// option を返す。バスが勝っていない（＝last-resort を引いていない・電車が勝った）
  /// ときは null で、#249 の train-only ガードが効き続ける。
  ///
  /// 最短のバス option を選んではいけない。last-resort が複数のバス便を返すとき、選定の
  /// 目的関数は「徒歩最大」なのに [_baseForHybrid] の基準は「総所要最小」なので両者は
  /// 食い違う。勝者と別の corridor を基準にすると、乗車バス停探索が勝者と無関係な停留所を
  /// 引き直して空振りし、勝ったバスは乗り通しのまま予算を余らせる。
  ///
  /// [selectBestRoute] はプールの要素をそのまま返すので、勝者は参照で [busCandidates] に
  /// 対応付けられる。対応付かないのは best-effort 縮退（[_resolveBoardingTimes] が実時刻を
  /// 当てたコピーを作る）経由で勝ったときだけ。そのときは予算外＝[_isCollapse] が対象外に
  /// するため基準は使われないが、従来どおり最短 option へフォールバックしておく。
  TransitOption? _busBaseFor(
    RouteCandidate winner,
    List<RouteCandidate>? busCandidates,
    List<TransitOption>? busOptions,
  ) {
    if (busOptions == null) return null;
    if (!winner.segments.any((s) => s.type == SegmentType.bus)) return null;
    final i = busCandidates?.indexWhere((c) => identical(c, winner)) ?? -1;
    final scope = i >= 0 ? [busOptions[i]] : busOptions;
    return _baseForHybrid(scope, allowBus: true);
  }

  /// コリドー（停車駅／線路点・バス停）を持つ最短の標準経路をハイブリッド・乗車駅探索の
  /// 基準にする。
  ///
  /// 既定ではバス混在 option を基準にしない（#249）。電車で予算内に収まる通常照会では
  /// バス corridor を基準に据える理由がなく、避けたバスが徒歩最大化の裏口から戻ってくる
  /// のを防ぐため。[allowBus] を立てるのは last-resort 再照会で得たバス option を基準に
  /// するときだけ（#251・[_busBaseFor] 経由）。
  TransitOption? _baseForHybrid(
    List<TransitOption> options, {
    bool allowBus = false,
  }) {
    TransitOption? best;
    int? bestMin;
    for (final o in options) {
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (!allowBus && o.segments.any((s) => s.type == SegmentType.bus)) {
        continue;
      }
      final min = o.segments.fold(0, (a, s) => a + s.minutes);
      if (best == null || min < bestMin!) {
        best = o;
        bestMin = min;
      }
    }
    return best;
  }

  /// ハイブリッドの土台に据える「路線ファミリの異なる代表 base」群（#292）。単一最速1本
  /// （[_baseForHybrid]）では別路線コリドー由来の徒歩多め候補が原理的に生成されない（限界2）。
  /// baseline の option 群を routeName 集合（[_routeFamilyKey]）でフィンガープリントして
  /// ファミリごとにまとめ、各ファミリの代表を最大 [_maxHybridBases] 本返す。**増分 API コストは
  /// ゼロ**——既に取得済みの単一 `/guidance/plan` レスポンスの option を追加で土台にするだけで、
  /// 新規照会は発行しない（#288 §4：素材は1回の照会に既に入っている）。
  ///
  /// ファミリ内の代表は現行の総所要 `minutes` 最小を踏襲する（限界1＝目的関数が徒歩 km か min かは
  /// 本 issue のスコープ外・#288）。ファミリ間の順序は総所要昇順、**同所要は代表 option の出現順**を
  /// タイブレークにする——[List.sort] は等価な相異要素の順序を保証しないため、これを入れないと
  /// 同所要のファミリで [bases].first が [_baseForHybrid]（出現順で最初の最短を採る）と食い違い、
  /// 崩壊時 board-search の基準コリドーが #292 前と変わってしまう（Codex 指摘）。タイブレークは
  /// ファミリの初出位置ではなく**代表（最短）option の位置**で行う——初出位置だと `A(20m),B(10m),
  /// A(10m)` で `_baseForHybrid` が B を採るのに A が先に来てしまう（Codex 指摘）。この順序保証で
  /// **先頭は [_baseForHybrid] の単一最速 base に一致し、単一ファミリのときは挙動が変わらない**。
  /// バス除外・コリドー2点未満除外のガードは [_baseForHybrid] と同一（main path は電車のみ）。
  @visibleForTesting
  List<TransitOption> basesForHybrid(List<TransitOption> options) {
    final repByFamily = <String, TransitOption>{};
    final minByFamily = <String, int>{};
    final repIndexByFamily = <String, int>{};
    for (var i = 0; i < options.length; i++) {
      final o = options[i];
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (o.segments.any((s) => s.type == SegmentType.bus)) continue;
      final key = _routeFamilyKey(o);
      final min = o.segments.fold(0, (a, s) => a + s.minutes);
      if (!minByFamily.containsKey(key) || min < minByFamily[key]!) {
        repByFamily[key] = o;
        minByFamily[key] = min;
        repIndexByFamily[key] = i;
      }
    }
    final families = repByFamily.keys.toList()
      ..sort((a, b) {
        final byMin = minByFamily[a]!.compareTo(minByFamily[b]!);
        return byMin != 0
            ? byMin
            : repIndexByFamily[a]!.compareTo(repIndexByFamily[b]!);
      });
    return [for (final k in families.take(_maxHybridBases)) repByFamily[k]!];
  }

  /// option を路線ファミリへ要約するフィンガープリント（#292）。transit 区間（電車・バス）の
  /// 路線名の集合（順不同・重複除去・ソート）で表す。同じ路線集合を通る option（捕まえる便
  /// だけが違う等）は同一ファミリとして1本に畳み、別路線を経由する option だけを別 base に
  /// する。素朴な「時間で上位N本」だと同一ファミリの重複を掴むだけで多様性が増えない（#288）。
  ///
  /// 路線名を欠く leg はコリドー形状で代替する。路線名が空（`routeName` 無し＝
  /// [RouteSegment.line] が null、または Transit API が `routeName: ""` を返す空文字）だと、
  /// 全部が同じキーへ畳まれて別コリドーが同一ファミリ扱いになり最速1本しか残らず、多様化が
  /// 静かに単一 base へ退行してしまう（Codex 指摘）。null も空文字も等しく「無名」とみなし、
  /// コリドー形状へフォールバックする。端点だけだと同一 OD の急行・各停のように端点を共有し
  /// 途中だけ違うコリドーを区別できないため、polyline を均等サンプルした座標列で表す
  /// （[_corridorFingerprintSamples] 点）。
  String _routeFamilyKey(TransitOption o) {
    final keys = <String>{
      for (final s in o.segments)
        if (s.type == SegmentType.train || s.type == SegmentType.bus)
          (s.line == null || s.line!.isEmpty)
              ? '@${_corridorFingerprint(s.polyline)}'
              : s.line!,
    }.toList()..sort();
    return keys.join('|');
  }

  /// 路線名を欠くコリドーのフィンガープリント。polyline を均等サンプルした座標列で、
  /// 端点を共有し途中だけ違うコリドー（同一 OD の急行/各停等）も区別する（[_routeFamilyKey]）。
  String _corridorFingerprint(List<GeoPoint> polyline) => [
    for (final p in evenSample(polyline, _corridorFingerprintSamples))
      _coordKey(p),
  ].join(',');

  static const int _corridorFingerprintSamples = 8;

  /// ハイブリッド候補を構造フィンガープリントへ要約し、複数 base 由来の同一候補を
  /// マージ時に重複除去する（#292）。乗降駅名は生成時点では空のことがあるため、区間の
  /// 種別・路線名と polyline 端点（5桁丸め）で表す——同じコリドー区間を同じ乗降座標で
  /// 通る候補は同一とみなす。座標丸めは徒歩レッグキャッシュ（[_walkCacheKey]）と同じ精度。
  String _hybridKey(RouteCandidate c) => [
    for (final s in c.segments)
      '${s.type.name}:${s.line ?? ''}:'
          '${_coordKey(s.polyline.isNotEmpty ? s.polyline.first : null)}>'
          '${_coordKey(s.polyline.isNotEmpty ? s.polyline.last : null)}',
  ].join('|');

  String _coordKey(GeoPoint? p) => p == null
      ? '-'
      : '${p.lat.toStringAsFixed(5)},${p.lng.toStringAsFixed(5)}';

  /// base ごとのハイブリッド群（[perBase]）を [_maxHybridCandidates] 本までマージ重複除去する
  /// （#292）。[within]（見積り到着が予算内か）が true の候補を**先に**上限まで詰め、余枠にのみ
  /// 予算外を足す。予算外の徒歩多め候補が上限を食い潰し、単一 base 時代なら選定へ渡っていた
  /// 予算内の短めハイブリッドを締め出して標準乗換/全徒歩へ縮退させる退行を防ぐ（Codex 指摘）。
  /// 各フェーズ内は base 間ラウンドロビン（各 base は徒歩多い順）で、1ファミリの候補群が他
  /// ファミリを締め出さないようにする（限界3）。[_hybridKey] で同一候補を除去する。
  @visibleForTesting
  List<RouteCandidate> mergeHybrids(
    List<List<RouteCandidate>> perBase,
    bool Function(RouteCandidate) within,
  ) {
    final sorted = [
      for (final list in perBase)
        [...list]..sort((a, b) => b.walkMinutes.compareTo(a.walkMinutes)),
    ];
    final seen = <String>{};
    final out = <RouteCandidate>[];
    for (final keepWithin in const [true, false]) {
      final phase = [
        for (final list in sorted)
          [
            for (final h in list)
              if (within(h) == keepWithin) h,
          ],
      ];
      for (var rank = 0; out.length < _maxHybridCandidates; rank++) {
        var progressed = false;
        for (final list in phase) {
          if (rank >= list.length) continue;
          progressed = true;
          if (seen.add(_hybridKey(list[rank]))) out.add(list[rank]);
          if (out.length >= _maxHybridCandidates) break;
        }
        if (!progressed) break;
      }
      if (out.length >= _maxHybridCandidates) break;
    }
    return out;
  }

  /// [base] の全コリドー座標を origin→goal 方向に連結し、乗車駅候補（[_CorridorStop]）へ
  /// 変換する。gtfsShape は頂点が密なため均等間引きで [_maxCorridorStops] 以下へ絞る（§2.5）。
  /// section は transit leg（電車・バス問わず）番号、line/type は対応するセグメントの
  /// 路線名・種別。`TransitCorridor.legIndex` は全 transit leg の通し番号のため、対応する
  /// セグメント列も train に絞らず transit 全体（電車・バス）で揃える（#249: train のみに
  /// 絞ると bus leg を挟んだ後続の legIndex がズレて誤った路線名を拾っていた）。
  List<_CorridorStop> _corridorStops(TransitOption base) {
    final transitSegs = [
      for (final s in base.segments)
        if (s.type == SegmentType.train || s.type == SegmentType.bus) s,
    ];
    final out = <_CorridorStop>[];
    for (final c in base.corridors) {
      final seg = c.legIndex < transitSegs.length
          ? transitSegs[c.legIndex]
          : null;
      for (final p in evenSample(c.coords, _maxCorridorStops)) {
        out.add(
          _CorridorStop(
            coord: p,
            section: c.legIndex,
            line: seg?.line,
            type: seg?.type ?? SegmentType.train,
          ),
        );
      }
    }
    return out;
  }

  /// コリドー区間 [b]→[a]（同一 section・連続インデックス）の折れ線長（km）。
  double _railKm(List<_CorridorStop> stops, int b, int a) {
    var km = 0.0;
    for (var i = b; i < a; i++) {
      km += haversineKm(stops[i].coord, stops[i + 1].coord);
    }
    return km;
  }

  // ---- Transit API（[TransitApiClient] 経由の引き直し） ----

  /// 引き直しの応答から、[at] 発で**到着が最も早い** option を選ぶ（同着は上流の並び順）。
  /// 該当が無ければ null。
  ///
  /// 素直には応答の先頭を採りたいが、`numItineraries` 本の並びは所要順である保証が無く、
  /// 実測では乗り換えを失って降車後166分歩く経路が先頭に来た（#343）。乗車駅探索の評価は
  /// 「この地点から時間内に着けるか」なので、悪い1本を掴んだ地点は予算外と誤判定され、
  /// 単調性を仮定した二分探索がそこから奥を丸ごと切り捨てる（実測で探索範囲の85%）。
  /// 判定と同じ尺度（[arrivalMinutes]）で選べば、採る候補は必ず先頭採用時と同じか良い。
  TransitOption? _earliestArrival(
    Iterable<TransitOption> options,
    DateTime at,
  ) {
    TransitOption? best;
    var bestArr = 0;
    for (final o in options) {
      final arr = arrivalMinutes(o.segments, at);
      if (best == null || arr < bestArr) {
        best = o;
        bestArr = arr;
      }
    }
    return best;
  }

  /// 乗車駅候補 X から goal への経路を引き直し、transit 区間を含む option のうち到着最早を
  /// [RouteCandidate] で返す（乗車駅探索の評価関数）。全徒歩しか返らなければ null。
  ///
  /// [allowBus] は基準コリドーの種別に揃える（#251）。バス corridor の乗車駅探索でバスを
  /// 除外して引くと、バス停 X からの経路が全徒歩に落ちて探索が空振りする。
  Future<RouteCandidate?> _fetchTransitFrom(
    GeoPoint x,
    GeoPoint goal,
    DateTime at, {
    bool allowBus = false,
    void Function()? onUpstreamFailure,
  }) async {
    final Map<String, dynamic> body;
    try {
      body = await _api.fetchGuidanceAt(x, goal, at, allowBus: allowBus);
    } on RouteException {
      // 上流の失敗（429・5xx・TIMEOUT）と「引けたが transit 区間が無い」を、呼び出し側は
      // どちらも null として同じに扱う（縮退の挙動は変えない）。ただし前者は**この地点が
      // 予算外だった**ことを意味しないので、境界を指標として読むときに区別が要る。
      onUpstreamFailure?.call();
      return null;
    }
    final options = parseGuidancePlan(
      body,
    ).where((o) => o.segments.any((s) => s.type != SegmentType.walk)).toList();
    final best = _earliestArrival(options, at);
    if (best == null) return null;
    if (options.length > 1) {
      _diag.log(
        () =>
            '引き直し候補 ${options.length}本 到着='
            '${options.map((o) => '${arrivalMinutes(o.segments, at)}m').join(',')}'
            ' → 到着最早 ${arrivalMinutes(best.segments, at)}m を採用',
      );
    }
    return RouteCandidate(
      from: best.from,
      to: best.to,
      segments: best.segments,
    );
  }

  // ---- Google Routes（[TransitApiClient] 経由の徒歩実測をドメイン候補へ変換） ----

  /// origin→dest の徒歩を Google Routes(WALK, プロキシ経由)で取得して徒歩区間候補にする。
  /// レッグ単位キャッシュ（座標5桁丸めキー）。失敗時は null。
  Future<RouteCandidate?> _tryWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
    _WalkLegCache? cache,
  }) async {
    // キャッシュのレッグ実測は区間名に依らずキー（座標丸め）で共有し、呼び出し側の
    // fromName/toName は取得後に _renameWalk で被せる。同一レッグを複数候補が同時に測る
    // 候補間並列（#315）では、resolve が in-flight の Future も単一化して二重発行を防ぐ。
    final key = _walkCacheKey(origin, dest);
    final result = cache == null
        ? await _fetchWalkLeg(origin, dest)
        : await cache.resolve(key, () => _fetchWalkLeg(origin, dest));
    return result == null ? null : _renameWalk(result, fromName, toName);
  }

  /// origin→dest の徒歩を Google 実測で1レッグ分取得する。区間名はキャッシュ共有のため
  /// 素の座標名で組み、呼び出し側が [_renameWalk] で被せる。上流失敗（[RouteException]）は
  /// null へ縮退するが、[SearchCanceledException] は別型なのでそのまま伝播する
  /// （cancellation.dart: キャンセルを縮退パスで飲まない）。
  Future<RouteCandidate?> _fetchWalkLeg(GeoPoint origin, GeoPoint dest) async {
    try {
      final body = await _api.fetchWalkRoute(origin, dest);
      final routes = body['routes'] as List<dynamic>? ?? const [];
      if (routes.isEmpty) return null;
      final route = routes.first as Map<String, dynamic>;
      final minutes = _parseDurationMin(route['duration']);
      if (minutes == null) return null;
      final km = ((route['distanceMeters'] as num?)?.toInt() ?? 0) / 1000.0;
      final shape = _parseEncodedPolyline(route['polyline']);
      return RouteCandidate(
        from: '',
        to: '',
        segments: [
          RouteSegment(
            type: SegmentType.walk,
            fromName: '',
            toName: '',
            minutes: minutes,
            km: km,
            kcal: (km * kcalPerKm).round(),
            polyline: shape.isNotEmpty ? shape : [origin, dest],
          ),
        ],
      );
    } on RouteException {
      return null;
    }
  }

  RouteCandidate _renameWalk(
    RouteCandidate cached,
    String fromName,
    String toName,
  ) => RouteCandidate(
    from: fromName,
    to: toName,
    segments: [
      cached.segments.first.copyWith(fromName: fromName, toName: toName),
    ],
  );

  /// origin→dest を直線距離から推定した徒歩区間候補にする（API 呼び出しなし）。
  RouteCandidate _estimateWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
  }) {
    final km = haversineKm(origin, dest);
    final minutes = (km * 1000 / walkMetersPerMinute).round();
    return RouteCandidate(
      from: fromName,
      to: toName,
      segments: [
        RouteSegment(
          type: SegmentType.walk,
          fromName: fromName,
          toName: toName,
          minutes: minutes,
          km: km,
          kcal: (km * kcalPerKm).round(),
          polyline: [origin, dest],
        ),
      ],
    );
  }

  String _walkCacheKey(GeoPoint origin, GeoPoint dest) =>
      '${origin.lat.toStringAsFixed(5)},${origin.lng.toStringAsFixed(5)}'
      '|${dest.lat.toStringAsFixed(5)},${dest.lng.toStringAsFixed(5)}';

  int? _parseDurationMin(Object? duration) {
    if (duration is! String) return null;
    final seconds = int.tryParse(duration.replaceAll('s', ''));
    if (seconds == null) return null;
    return (seconds / 60).round();
  }

  List<GeoPoint> _parseEncodedPolyline(Object? polyline) {
    final encoded = polyline is Map ? polyline['encodedPolyline'] : null;
    if (encoded is! String || encoded.isEmpty) return const [];
    return [
      for (final p in decodePolyline(encoded))
        GeoPoint(p[0].toDouble(), p[1].toDouble()),
    ];
  }

  /// 出発の絶対時刻。dateOffset（isNow→0）で日付を決定する。
  DateTime _departureDateTime(TimeValue t) {
    final now = _clock();
    return DateTime(
      now.year,
      now.month,
      now.day,
      t.h,
      t.m,
    ).add(Duration(days: effectiveOffset(t)));
  }
}

/// 乗車駅探索・ハイブリッドの候補点。コリドー座標（停車駅 or 線路点）から作る。
/// 時刻・運賃は持たない（Transit API では取得不可・§5）。
class _CorridorStop {
  const _CorridorStop({
    required this.coord,
    required this.section,
    required this.line,
    required this.type,
  });

  final GeoPoint coord;

  /// 属する transit leg（電車・バス問わず）番号。乗換をまたぐ点は番号が異なる。
  final int section;
  final String? line;

  /// この点が属する区間種別（電車 or バス）。通常照会では train のみ。last-resort の
  /// バス候補を基準に据えたときだけ bus になる（#251）。
  final SegmentType type;

  /// ハイブリッド駅名は不明（コリドー座標に駅名は付かない）。空表示。
  String get name => '';
}

/// 徒歩レッグ実測の1検索分キャッシュ。完了結果に加えて **in-flight の Future** も
/// レッグキーで共有する。#315 で予算内候補を候補**間**並列で一括実測するようになり、
/// 同一 egress レッグ（例: 同じ降車駅→目的地）を持つ候補が同時に enrich されるが、
/// 完了結果しか持たない素の Map では両者ともキャッシュを外して `googleWalkProxy` を
/// 二重発行する——直列 reject-reselect が得ていた共有が消える。in-flight を単一化し、
/// 共有レッグの実測を候補数に依らず1回へ畳む。
class _WalkLegCache {
  final Map<String, RouteCandidate> _done = {};
  final Map<String, Future<RouteCandidate?>> _inflight = {};

  /// [key] の実測を単一化する。完了済みなら即返し、実行中なら同じ Future に相乗り、
  /// どちらも無ければ [fetch] を1回だけ起こす。失敗（null 解決や例外）は永続キャッシュ
  /// しない——一過性のプロキシ失敗を検索の残り全体へ固定しないため。
  Future<RouteCandidate?> resolve(
    String key,
    Future<RouteCandidate?> Function() fetch,
  ) {
    final done = _done[key];
    if (done != null) return Future.value(done);
    // 相乗り者・起動者が全員この1本を await するよう、in-flight は単一の Future に統一する。
    // whenComplete で後始末を別 Future へ枝分かれさせると、fetch がエラーで倒れたとき誰も
    // await しない枝が未処理例外になる（catch 済みでもテストが落ちる）。try/finally なら
    // エラーは唯一の Future に載ってすべての await 側で処理される。
    return _inflight[key] ??= _resolveUncached(key, fetch);
  }

  Future<RouteCandidate?> _resolveUncached(
    String key,
    Future<RouteCandidate?> Function() fetch,
  ) async {
    try {
      final result = await fetch();
      if (result != null) _done[key] = result;
      return result;
    } finally {
      // 除去される Future は今まさに解決中の自分自身。await せず捨てる（相乗り者が処理する）。
      unawaited(_inflight.remove(key));
    }
  }
}
