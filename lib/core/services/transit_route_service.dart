import 'dart:async';
import 'dart:convert';

import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'hybrid_route_selector.dart';
import 'route_diagnostics.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';
import 'transit_plan_parser.dart';

/// Transit API（`/guidance/plan`）から、予算内で徒歩を最大化するルートを生成する
/// `RouteService`（#137）。NAVITIME 版（[NaviTimeRouteService]）を置換する。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測だけは
/// Google Routes プロキシ（App Check）を介す。選定（measure-first・乗車駅探索・
/// best-effort 縮退）と純粋関数（[selectBestRoute]/[maxWalkBoardingIndex]/
/// [frontierStations]/[arrivalMinutes]/[buildRoutePlan]）はデータ源非依存なので流用する。
///
/// NAVITIME 版との差（docs/notes/transit-api-migration.md）：
/// - 途中停車駅は `/guidance/plan` の transit polyline（コリドー座標）で代替し、
///   乗車駅探索はコリドーを間引きサンプリングして `plan(X→goal)` を引き直す（§2.5）。
/// - 運賃は取得不可のため廃止（§5）。乗り遅れ再照会（#115）は乗車駅探索へ一本化し
///   廃止（§4）。引き直し便は自己整合なので `firstMissedTrain` が立たない。
class TransitRouteService implements RouteService {
  TransitRouteService({
    http.Client? transitClient,
    http.Client? proxyClient,
    String? transitBaseUrl,
    String? proxyBaseUrl,
    DateTime Function()? clock,
  }) : _transit = transitClient ?? http.Client(),
       _proxy = proxyClient ?? http.Client(),
       _clock = clock ?? DateTime.now,
       _transitBaseUrl = (transitBaseUrl ?? AppConfig.transitApiBaseUrl)
           .replaceAll(RegExp(r'/+$'), ''),
       _proxyBaseUrl = (proxyBaseUrl ?? AppConfig.proxyBaseUrl).replaceAll(
         RegExp(r'/+$'),
         '',
       );

  final http.Client _transit;
  final http.Client _proxy;
  final String _transitBaseUrl;
  final String _proxyBaseUrl;
  final DateTime Function() _clock;

  /// 選定の診断ログ整形（#169）。`verbose` は既定で [kDebugMode]。
  final RouteDiagnostics _diag = const RouteDiagnostics();

  /// `/guidance/plan` で取得する候補数。
  static const int _numItineraries = 5;

  /// 採用候補を enrich（街路実測）で検証して選び直す試行上限。
  static const int _maxEnrichAttempts = 8;

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
  static const int _boardSearchFanout = 3;

  /// 乗車駅探索のコリドー候補点の上限。gtfsShape は線路追従で頂点が密（数百）なため、
  /// 均等間引きでこの数へ絞る（§2.5）。二分探索は実測 walk で駆動するので評価回数は
  /// O(log n) のまま、候補点が密なほど境界の解像度が上がり余りが小さくなる（#137）。
  /// 旧値 25 では隣接候補が約30分徒歩も離れ、境界で徒歩を予算ぎりぎりまで詰められず
  /// 余りが残っていたため引き上げた。
  static const int _maxCorridorStops = 60;

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
    if (_transitBaseUrl.isEmpty) throw const RouteException('NO_TRANSIT_API');
    if (origin == null) throw const RouteException('NO_ORIGIN');
    if (destinationLatLng == null) throw const RouteException('NO_DESTINATION');
    final budgetMin = budgetMinutes(departure, arrival);

    onProgress?.call(RoutePhase.routing);

    final departureAt = _departureDateTime(departure);
    final body = await _fetchGuidance(origin, destinationLatLng, departureAt);
    final options = parseGuidancePlan(body);
    if (options.isEmpty) throw const RouteException('ZERO_RESULTS');

    onProgress?.call(RoutePhase.walkability);

    return _selectMeasured(
      options,
      budgetMin,
      departure,
      origin: origin,
      goal: destinationLatLng,
      onProgress: onProgress,
      fromName: originName,
      toName: destination,
    );
  }

  /// measure-first 選定。標準乗換・実測ハイブリッド・全徒歩を同一土俵で比較し、
  /// 採用候補を Google 実測（enrich）で検証して確定する。徒歩最大化が崩壊したときだけ
  /// 乗車駅探索（引き直し）を1本足して選び直す。
  Future<RoutePlan> _selectMeasured(
    List<TransitOption> options,
    int budgetMin,
    TimeValue departure, {
    required GeoPoint origin,
    required GeoPoint goal,
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
    final walkCache = <String, RouteCandidate>{};
    final measured = <String, int>{};

    // 標準乗換候補（guidance の door-to-door をそのまま候補化）。
    final candidates = <RouteCandidate>[
      for (final o in options)
        RouteCandidate(from: o.from, to: o.to, segments: o.segments),
    ];
    for (final c in candidates) {
      _diag.log(() => 'standard: ${_diag.candLine(c, budgetMin, departureAt)}');
    }

    final base = _baseForHybrid(options);
    if (base != null) {
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
      candidates.addAll(hybrids);
      _diag.log(() => 'built ${hybrids.length} hybrids:');
      for (final c in hybrids) {
        _diag.log(
          () => '  hybrid: ${_diag.candLine(c, budgetMin, departureAt)}',
        );
      }
    } else {
      _diag.log(() => 'no base route (corridor<2); all-walk only');
      await _measureAccessWalks(origin, goal, const [], const [], measured);
    }

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

    var selected = await _selectAndEnrich(
      candidates,
      budgetMin,
      departureAt,
      origin: origin,
      goal: goal,
      walkCache: walkCache,
    );

    _diag.log(
      () =>
          'selected(initial): '
          'chosen(見積り)=${_diag.candLine(selected.chosen, budgetMin, departureAt)} | '
          'enriched(実測)=${_diag.candLine(selected.enriched, budgetMin, departureAt)}',
    );

    // 崩壊判定は enrich 前の選定候補（[selected.chosen]）で行う。enrich 後の徒歩は
    // Google 実街路で膨らみ、標準乗換の guidance 見積り徒歩と測定基準がずれるため、
    // 両者を同じ見積り基準で比較しないと崩壊が誤って不成立になる（徒歩最大化の不達）。
    if (base != null &&
        _isCollapse(selected.chosen, options, budgetMin, departureAt)) {
      _diag.log(() => 'collapse=true → board-search フォールバック起動');
      final boardSearch = await _buildBoardSearchCandidate(
        base,
        origin,
        goal,
        budgetMin,
        departureAt,
        walkCache,
      );
      if (boardSearch.isNotEmpty) {
        _diag.log(() => 'board-search候補: ${boardSearch.length}件をプールへ追加');
        selected = await _selectAndEnrich(
          [...candidates, ...boardSearch],
          budgetMin,
          departureAt,
          origin: origin,
          goal: goal,
          walkCache: walkCache,
        );
        _diag.log(
          () =>
              'selected(after board-search): '
              '${_diag.candLine(selected.enriched, budgetMin, departureAt)}',
        );
      } else {
        _diag.log(() => 'board-search候補: なし');
      }
    } else if (base != null) {
      _diag.log(() => 'collapse=false → フォールバック起動せず');
    }

    final named = await _finalizeStationNames(selected.enriched, departureAt);
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

  /// 確定経路の電車区間に乗降駅名が無い（コリドー座標由来の候補）ときだけ、その乗車座標
  /// →降車座標で `/guidance/plan` を1回引き直して leg の実駅名を復元する（確定候補のみ・
  /// 追加コール最小）。続けて隣接徒歩区間の端点へ駅名を伝播し、タイムラインの乗車駅ノード
  /// （直前徒歩の toName を place に使う）と電車カードに駅名を出す。
  Future<RouteCandidate> _finalizeStationNames(
    RouteCandidate chosen,
    DateTime departureAt,
  ) async {
    final segs = [...chosen.segments];
    for (var i = 0; i < segs.length; i++) {
      final seg = segs[i];
      if (seg.type != SegmentType.train) continue;
      if (seg.fromName.isNotEmpty && seg.toName.isNotEmpty) continue;
      if (seg.polyline.length < 2) continue;
      final names = await _fetchTrainEndpoints(
        seg.polyline.first,
        seg.polyline.last,
        departureAt,
      );
      if (names == null) continue;
      segs[i] = seg.copyWith(
        fromName: seg.fromName.isEmpty ? names.from : null,
        toName: seg.toName.isEmpty ? names.to : null,
      );
    }
    _propagateStationNames(segs);
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segs);
  }

  /// 乗車座標 [board]→降車座標 [alight] を [at] 発で引き直し、最初に電車を含む option の
  /// 先頭電車の乗車駅名・実発車時刻、末尾電車の降車駅名・実到着時刻を返す。電車を含む
  /// option が無い・取得失敗なら null。コリドー由来候補の駅名復元（[_finalizeStationNames]）
  /// と実時刻検証（[_resolveBoardingTimes]・approach A）で共有する。
  Future<({String from, String to, DateTime? dep, DateTime? arr})?>
  _fetchTrainEndpoints(GeoPoint board, GeoPoint alight, DateTime at) async {
    final Map<String, dynamic> body;
    try {
      body = await _fetchGuidanceAt(board, alight, at);
    } on RouteException {
      return null;
    }
    for (final o in parseGuidancePlan(body)) {
      final trains = o.segments
          .where((s) => s.type == SegmentType.train)
          .toList();
      if (trains.isNotEmpty) {
        return (
          from: trains.first.fromName,
          to: trains.last.toName,
          dep: trains.first.depTime,
          arr: trains.last.arrTime,
        );
      }
    }
    return null;
  }

  /// approach A（時刻なしハイブリッドの実時刻検証）。コリドー由来の電車区間は距離概算の
  /// minutes だけを持ち depTime を欠くため、乗車待ち（終電後・運行時間外の翌朝始発待ちを
  /// 含む）が [arrivalMinutes] に反映されず、走っていない電車が予算内へ化ける（#137 実機の
  /// 深夜02:41／全ハイブリッド maxWait=0m）。採用候補の時刻なし電車区間について、乗車座標
  /// →降車座標を実 boardAt（出発＋その区間までの実累積分）で `/guidance/plan` 引き直しし、
  /// 最初の電車 leg の実発着時刻を当てる。引き直し便は boardAt 以降発の実ダイヤなので、
  /// 乗車待ち・乗車時間が実時刻で入り、深夜は始発待ちで予算外へ正しく落ちる。
  /// boardAt より前発（実ダイヤと不整合・乗れない便）・取得失敗・電車便なしの区間は当てない。
  /// 駅名も同時に復元する（[_finalizeStationNames] の再照会を省ける）。
  Future<RouteCandidate> _resolveBoardingTimes(
    RouteCandidate cand,
    DateTime departureAt,
  ) async {
    final segs = [...cand.segments];
    var changed = false;
    for (var i = 0; i < segs.length; i++) {
      final seg = segs[i];
      if (seg.type != SegmentType.train) continue;
      if (seg.depTime != null) continue; // 既に実時刻あり（標準乗換・board-search）
      if (seg.polyline.length < 2) continue;
      final cumBefore = arrivalMinutes(segs.sublist(0, i), departureAt);
      final boardAt = departureAt.add(Duration(minutes: cumBefore));
      // 区間間は並列化しない（#163 対象外）: 後続区間の boardAt（cumBefore）が前区間で
      // 解決した実乗車時間・乗車待ちに依存するため、直列でないと照会時刻がずれる。
      final ep = await _fetchTrainEndpoints(
        seg.polyline.first,
        seg.polyline.last,
        boardAt,
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

  /// 電車区間の乗降駅名を、直前（乗車駅）・直後（降車駅）の徒歩区間の端点が空のときだけ
  /// 写す。タイムラインの乗車駅ノードは直前徒歩の toName、降車後の徒歩は fromName を
  /// place に使うため。出発地・目的地の端（非空）は上書きしない。
  void _propagateStationNames(List<RouteSegment> segs) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].type != SegmentType.train) continue;
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

  /// 候補から決定的に選定し、採用1経路を Google 実測（enrich）で検証する確定ループ。
  /// NAVITIME 版と違い**乗り遅れ再照会（#115）は行わない**：実在便への差し替えはせず、
  /// enrich で (a) 予算超過、または (b) 先頭電車に乗り遅れ（標準乗換のアクセス徒歩が実街路で
  /// 伸び駅着が発車後になる・#137 副次）が判明した候補は除外して乗れる次善へ選び直す。
  /// ハイブリッド／乗車駅探索は引き直しまたは時刻なし距離概算のため `firstMissedTrain` は
  /// 構成上立たず、(b) は主に標準乗換に効く。
  /// 戻り値の [chosen] は enrich 前の選定候補（guidance 見積り徒歩のまま）、
  /// [enriched] は採用経路を Google 実測で確定したもの。崩壊判定（[_isCollapse]）が
  /// 標準乗換と同じ見積り基準で比較できるよう、両方を返す。
  Future<({RouteCandidate chosen, RouteCandidate enriched})> _selectAndEnrich(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt, {
    required GeoPoint origin,
    required GeoPoint goal,
    required Map<String, RouteCandidate> walkCache,
  }) async {
    var pool = candidates;
    for (var attempt = 0; ; attempt++) {
      final chosen = selectBestRoute(
        candidates: pool,
        budgetMin: budgetMin,
        origin: origin,
        goal: goal,
        departureAt: departureAt,
      );
      final withinByEstimate =
          arrivalMinutes(chosen.segments, departureAt) <= budgetMin;
      _diag.log(
        () =>
            'enrich attempt=$attempt pool=${pool.length} '
            'chosen: ${_diag.candLine(chosen, budgetMin, departureAt)}',
      );
      if (!withinByEstimate) {
        _diag.log(() => '  → 予算内候補なし → best-effort 縮退');
        return await _bestEffortResolved(
          candidates,
          budgetMin,
          departureAt,
          walkCache,
        );
      }

      // enrich（実測徒歩）に加え、時刻なしハイブリッドの電車区間へ実発車時刻を当てる
      // （approach A）。これで乗車待ち（深夜の始発待ち等）が arrivalMinutes に入り、
      // 走っていない電車が予算内へ化けるのを防ぐ。
      final enriched = await _resolveBoardingTimes(
        await _enrichWalkGeometry(chosen, walkCache),
        departureAt,
      );
      // enrich／実時刻検証で (a) 予算超過に転じた、または (b) 先頭電車に乗り遅れる（標準乗換の
      // アクセス徒歩が guidance 見積りより実街路で伸び、駅着が発車後になる）候補は除外して
      // 選び直す。除外は実測の確認時だけ。乗り遅れは「予算内に見えても実際には乗れない」
      // 経路なので、予算超過と同様に確定させない（#137 副次）。
      final overBudget =
          arrivalMinutes(enriched.segments, departureAt) > budgetMin;
      final missedAfterEnrich =
          firstMissedTrain(enriched.segments, departureAt) != null;
      // (c) 引き直しでも実発車時刻を確認できなかった時刻なし電車を含む＝その時間に便が
      // 無い疑い。予算内に見えても走っている確証が無いため確定させない（#137 深夜の幻便）。
      final unverifiedTrain = enriched.segments.any(
        (s) => s.type == SegmentType.train && s.depTime == null,
      );
      if (attempt < _maxEnrichAttempts &&
          pool.length > 1 &&
          (overBudget || missedAfterEnrich || unverifiedTrain)) {
        _diag.log(
          () =>
              '  → enrich実測で'
              '${overBudget
                  ? '予算超過'
                  : missedAfterEnrich
                  ? '先頭電車に乗り遅れ'
                  : '実発車時刻を確認できず'}'
              '→除外して選び直し: ${_diag.candLine(enriched, budgetMin, departureAt)}',
        );
        pool = pool.where((c) => !identical(c, chosen)).toList();
        continue;
      }
      // 除外しきれず未確認電車が残るときは確定させず best-effort（検証済み）へ縮退する。
      if (unverifiedTrain) {
        _diag.log(() => '  → 未確認電車のまま確定不可 → best-effort 縮退');
        return await _bestEffortResolved(
          candidates,
          budgetMin,
          departureAt,
          walkCache,
        );
      }
      _diag.log(
        () => '  → 確定: ${_diag.candLine(enriched, budgetMin, departureAt)}',
      );
      return (chosen: chosen, enriched: enriched);
    }
  }

  /// best-effort 縮退（#121／#137 深夜）。候補へ実発車時刻を当て（approach A）、引き直しでも
  /// 実時刻を確認できなかった時刻なし電車を含む候補（その時間に便が無い疑い＝幻便）を除いた
  /// うえで「今夜乗れる範囲の実到着最早」を選ぶ。検証済みが皆無なら元の解決済み候補へ戻す
  /// （全徒歩は電車を含まず常に残るため通常は空にならない）。
  Future<({RouteCandidate chosen, RouteCandidate enriched})>
  _bestEffortResolved(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt,
    Map<String, RouteCandidate> walkCache,
  ) async {
    // 候補ごとの実時刻解決は互いに独立なので並列に投げる（#163）。候補内の区間ループは
    // 後続区間の boardAt が前区間の解決済み実乗車時間に依存するため直列のまま。
    final resolved = await Future.wait([
      for (final c in candidates) _resolveBoardingTimes(c, departureAt),
    ]);
    final verified = [
      for (final c in resolved)
        if (c.segments.every(
          (s) => s.type != SegmentType.train || s.depTime != null,
        ))
          c,
    ];
    final fallback = _bestEffort(
      verified.isNotEmpty ? verified : resolved,
      budgetMin,
      departureAt,
    );
    return (
      chosen: fallback,
      enriched: await _enrichWalkGeometry(fallback, walkCache),
    );
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

  /// 乗車駅探索（docs/notes/walk-max-board-search.md / transit-api-migration.md §2.5）。
  /// [base] のコリドー座標を乗車駅候補（前半徒歩 t1 の昇順）とし、各点 X から
  /// `/guidance/plan(X→goal, departureAt+t1)` を引き直して「到着が予算内の最遠＝総徒歩
  /// 最大」を [maxWalkBoardingIndexParallel]（k分割並列探索・#163）で探索する。各ラウンド
  /// [_boardSearchFanout] 点を同時評価して Transit API レイテンシの直列積み上げを避ける。
  /// 評価点の集合は直列二分探索と異なるため、戻り値の候補群も直列版と変わり得る。
  /// 引き直し便は X 発で自己整合なので `firstMissedTrain` が立たない。コリドー候補は
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
    Map<String, RouteCandidate> walkCache,
  ) async {
    final stops = _corridorStops(base);
    if (stops.length < 2) return const [];

    // 探索が同じ index を再評価しても引き直さないようメモ化する。同一ラウンド内の
    // 評価点は重複除去済み（[maxWalkBoardingIndexParallel]）なので同時実行は衝突しない。
    final built = <int, RouteCandidate?>{};
    Future<RouteCandidate?> buildAt(int i) async {
      if (built.containsKey(i)) return built[i];
      final x = stops[i];
      // 前半徒歩は実測（失敗時のみ直線推定へフォールバック）。
      final walk1 =
          await _tryWalk(
            origin,
            x.coord,
            fromName: base.from,
            toName: '',
            cache: walkCache,
          ) ??
          _estimateWalk(origin, x.coord, fromName: base.from, toName: '');
      final boardAt = departureAt.add(Duration(minutes: walk1.totalMin));
      final xToGoal = await _fetchTransitFrom(x.coord, goal, boardAt);
      if (xToGoal == null) {
        _diag.log(
          () => 'board-search i=$i walk1=${walk1.totalMin}m guidance失敗',
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
      count: stops.length,
      budgetMin: budgetMin,
      fanout: _boardSearchFanout,
      evaluate: (i) async {
        final c = await buildAt(i);
        // 経路無し（引き直し失敗）は予算外として扱い、手前の駅を探す。
        return c == null
            ? budgetMin + (1 << 20)
            : arrivalMinutes(c.segments, departureAt);
      },
    );
    _diag.log(
      () =>
          'board-search: 実測k分割並列探索の境界 best='
          '${best == null ? 'null(予算内乗車駅なし)' : '$best'} / コリドー点${stops.length}',
    );
    // 探索が評価した点（メモ化済み）のうち、予算内の候補を「全部」返す。境界 best 1本だけ
    // でなく全部を返すのは：(1) 到着は実街路で非単調になり得る（後方の停車駅が origin に近い等）
    // ため境界＝徒歩最大とは限らず、(2) 採用前に逆戻りフィルタ・乗り遅れ除外で1本が消えても、
    // 次善の board-search 候補へ落とせるようにするため。選定（[selectBestRoute] /
    // [_selectAndEnrich]）が逆戻り・到着の非単調を込みで「生き残る中の徒歩最大」を決める。
    final within = [
      for (final c in built.values)
        if (c != null && arrivalMinutes(c.segments, departureAt) <= budgetMin)
          c,
    ];
    _diag.log(() => 'board-search: 予算内候補 ${within.length}件を返す');
    return within;
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
    final boardFuture = _fetchWalkMatrix([origin], boardDests);
    final alightFuture = alightStops.isEmpty
        ? Future<List<dynamic>?>.value(null)
        : _fetchWalkMatrix(alightStops, [goal]);
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
                type: SegmentType.train,
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
    Map<String, RouteCandidate> cache,
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

  /// コリドー（停車駅／線路点）を持つ最短の標準経路をハイブリッド・乗車駅探索の基準にする。
  TransitOption? _baseForHybrid(List<TransitOption> options) {
    TransitOption? best;
    int? bestMin;
    for (final o in options) {
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      final min = o.segments.fold(0, (a, s) => a + s.minutes);
      if (best == null || min < bestMin!) {
        best = o;
        bestMin = min;
      }
    }
    return best;
  }

  /// [base] の全コリドー座標を origin→goal 方向に連結し、乗車駅候補（[_CorridorStop]）へ
  /// 変換する。gtfsShape は頂点が密なため均等間引きで [_maxCorridorStops] 以下へ絞る（§2.5）。
  /// section は電車区間（leg）番号、line は対応する train セグメントの路線名。
  List<_CorridorStop> _corridorStops(TransitOption base) {
    final trainLines = [
      for (final s in base.segments)
        if (s.type == SegmentType.train) s.line,
    ];
    final out = <_CorridorStop>[];
    for (final c in base.corridors) {
      final line = c.legIndex < trainLines.length
          ? trainLines[c.legIndex]
          : null;
      for (final p in evenSample(c.coords, _maxCorridorStops)) {
        out.add(_CorridorStop(coord: p, section: c.legIndex, line: line));
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

  // ---- Transit API（直叩き） ----

  Future<Map<String, dynamic>> _fetchGuidance(
    GeoPoint origin,
    GeoPoint goal,
    DateTime departureAt,
  ) => _fetchGuidanceAt(origin, goal, departureAt);

  Future<Map<String, dynamic>> _fetchGuidanceAt(
    GeoPoint start,
    GeoPoint goal,
    DateTime at,
  ) async {
    final uri = Uri.parse('$_transitBaseUrl/api/v1/guidance/plan').replace(
      queryParameters: {
        'from': 'geo:${start.lat},${start.lng}',
        'to': 'geo:${goal.lat},${goal.lng}',
        'date': _formatDate(at),
        'time': _formatTime(at),
        'type': 'departure',
        'numItineraries': '$_numItineraries',
      },
    );
    final res = await _getOrTimeout(_transit, uri);
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// 乗車駅候補 X から goal への経路を引き直し、最初に電車を含む option を
  /// [RouteCandidate] で返す（乗車駅探索の評価関数）。電車を含む option が無ければ null。
  Future<RouteCandidate?> _fetchTransitFrom(
    GeoPoint x,
    GeoPoint goal,
    DateTime at,
  ) async {
    final Map<String, dynamic> body;
    try {
      body = await _fetchGuidanceAt(x, goal, at);
    } on RouteException {
      return null;
    }
    for (final o in parseGuidancePlan(body)) {
      if (o.segments.any((s) => s.type == SegmentType.train)) {
        return RouteCandidate(from: o.from, to: o.to, segments: o.segments);
      }
    }
    return null;
  }

  // ---- Google Routes（プロキシ） ----

  Future<List<dynamic>?> _fetchWalkMatrix(
    List<GeoPoint> origins,
    List<GeoPoint> dests,
  ) async {
    String join(List<GeoPoint> ps) =>
        ps.map((p) => '${p.lat},${p.lng}').join(';');
    try {
      return await _fetchProxyArray('googleWalkMatrixProxy', {
        'origins': join(origins),
        'destinations': join(dests),
      });
    } on RouteException {
      return null;
    }
  }

  /// origin→dest の徒歩を Google Routes(WALK, プロキシ経由)で取得して徒歩区間候補にする。
  /// レッグ単位キャッシュ（座標5桁丸めキー）。失敗時は null。
  Future<RouteCandidate?> _tryWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
    Map<String, RouteCandidate>? cache,
  }) async {
    if (cache != null) {
      final hit = cache[_walkCacheKey(origin, dest)];
      if (hit != null) return _renameWalk(hit, fromName, toName);
    }
    try {
      final body = await _fetchProxy('googleWalkProxy', {
        'start': '${origin.lat},${origin.lng}',
        'goal': '${dest.lat},${dest.lng}',
      });
      final routes = body['routes'] as List<dynamic>? ?? const [];
      if (routes.isEmpty) return null;
      final route = routes.first as Map<String, dynamic>;
      final minutes = _parseDurationMin(route['duration']);
      if (minutes == null) return null;
      final km = ((route['distanceMeters'] as num?)?.toInt() ?? 0) / 1000.0;
      final shape = _parseEncodedPolyline(route['polyline']);
      final result = RouteCandidate(
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
            polyline: shape.isNotEmpty ? shape : [origin, dest],
          ),
        ],
      );
      if (cache != null) cache[_walkCacheKey(origin, dest)] = result;
      return result;
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

  Future<Map<String, dynamic>> _fetchProxy(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _getOrTimeout(_proxy, uri);
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  Future<List<dynamic>> _fetchProxyArray(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _getOrTimeout(_proxy, uri);
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) throw const RouteException('MATRIX_NOT_ARRAY');
    return decoded;
  }

  /// [client] で [uri] を GET し、タイムアウト（[TimeoutHttpClient]・#156）を
  /// `RouteException('TIMEOUT')` へ変換する。これで無応答は既存の UI エラー処理と
  /// 縮退（失敗レッグは `on RouteException` で直線推定・候補スキップ）にそのまま乗る。
  Future<http.Response> _getOrTimeout(http.Client client, Uri uri) async {
    try {
      return await client.get(uri);
    } on TimeoutException {
      throw const RouteException('TIMEOUT');
    }
  }

  /// 出発の絶対時刻。dateOffset（isNow→0）で日付を決定する（NAVITIME 版と同基準）。
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

  String _formatDate(DateTime dt) =>
      '${dt.year.toString().padLeft(4, '0')}'
      '${dt.month.toString().padLeft(2, '0')}'
      '${dt.day.toString().padLeft(2, '0')}';

  String _formatTime(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}

/// 乗車駅探索・ハイブリッドの候補点。コリドー座標（停車駅 or 線路点）から作る。
/// 時刻・運賃は持たない（Transit API では取得不可・§5）。
class _CorridorStop {
  const _CorridorStop({
    required this.coord,
    required this.section,
    required this.line,
  });

  final GeoPoint coord;

  /// 属する電車区間（leg）番号。乗換をまたぐ点は番号が異なる。
  final int section;
  final String? line;

  /// ハイブリッド駅名は不明（コリドー座標に駅名は付かない）。空表示。
  String get name => '';
}
