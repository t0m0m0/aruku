import 'dart:convert';

import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'hybrid_route_selector.dart';
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

  /// `/guidance/plan` で取得する候補数。
  static const int _numItineraries = 5;

  /// 採用候補を enrich（街路実測）で検証して選び直す試行上限。
  static const int _maxEnrichAttempts = 8;

  /// アクセス徒歩を一括実測するマトリクスの片側の駅数上限（要素数課金を抑える）。
  static const int _maxMatrixSideStations = 10;

  /// 乗車駅探索フォールバックの起動しきい値（崩壊判定・§7）。
  static const int _collapseWalkMarginMin = 10;
  static const double _collapseSlackRatio = 0.4;

  /// 乗車駅探索で境界から手前へ実街路 walk 確定を試す最大駅数。
  static const int _boardSearchVerifySteps = 4;

  /// 乗車駅探索のコリドー候補点の上限。gtfsShape は線路追従で頂点が密（数百）なため、
  /// 二分探索の引き直し回数（O(log n)）を抑えるよう均等間引きでこの数へ絞る（§2.5）。
  static const int _maxCorridorStops = 25;

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
    final walkCache = <String, RouteCandidate>{};
    final measured = <String, int>{};

    // 標準乗換候補（guidance の door-to-door をそのまま候補化）。
    final candidates = <RouteCandidate>[
      for (final o in options)
        RouteCandidate(from: o.from, to: o.to, segments: o.segments),
    ];

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
      await _measureAccessWalks(
        origin,
        goal,
        [for (final i in frontier.boarding) stops[i].coord],
        [for (final i in frontier.alighting) stops[i].coord],
        measured,
      );
      candidates.addAll(
        _buildMeasuredHybrids(base, stops, frontier, measured, origin, goal),
      );
    } else {
      await _measureAccessWalks(origin, goal, const [], const [], measured);
    }

    candidates.add(
      _measuredWalk(
        origin,
        goal,
        options.first.from,
        options.first.to,
        measured,
      ),
    );

    var enriched = await _selectAndEnrich(
      candidates,
      budgetMin,
      departureAt,
      origin: origin,
      goal: goal,
      walkCache: walkCache,
    );

    if (base != null &&
        _isCollapse(enriched, options, budgetMin, departureAt)) {
      final boardSearch = await _buildBoardSearchCandidate(
        base,
        origin,
        goal,
        budgetMin,
        departureAt,
        walkCache,
      );
      if (boardSearch != null) {
        enriched = await _selectAndEnrich(
          [...candidates, boardSearch],
          budgetMin,
          departureAt,
          origin: origin,
          goal: goal,
          walkCache: walkCache,
        );
      }
    }

    return _build(
      enriched,
      departure,
      budgetMin,
      onProgress,
      fromName: fromName,
      toName: toName,
    );
  }

  /// 候補から決定的に選定し、採用1経路を Google 実測（enrich）で検証する確定ループ。
  /// NAVITIME 版と違い**乗り遅れ再照会（#115）は行わない**：標準乗換は guidance が返す
  /// 実在便で自己整合、ハイブリッド／乗車駅探索は引き直しまたは時刻なし距離概算のため
  /// `firstMissedTrain` が構成上立たない。enrich で予算超過が判明したら除外して選び直す。
  Future<RouteCandidate> _selectAndEnrich(
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
      if (!withinByEstimate) {
        return _enrichWalkGeometry(
          _bestEffort(candidates, budgetMin, departureAt),
          walkCache,
        );
      }

      final enriched = await _enrichWalkGeometry(chosen, walkCache);
      if (attempt < _maxEnrichAttempts &&
          pool.length > 1 &&
          arrivalMinutes(enriched.segments, departureAt) > budgetMin) {
        pool = pool.where((c) => !identical(c, chosen)).toList();
        continue;
      }
      return enriched;
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
  /// [_collapseWalkMarginMin] 以下しか上回らない、(2) 予算を [_collapseSlackRatio] 以上
  /// 余らせている、の両方を満たすとき true。best-effort（予算外）は対象外。
  bool _isCollapse(
    RouteCandidate winner,
    List<TransitOption> options,
    int budgetMin,
    DateTime departureAt,
  ) {
    final arrival = arrivalMinutes(winner.segments, departureAt);
    if (arrival > budgetMin) return false;
    if (budgetMin - arrival < budgetMin * _collapseSlackRatio) return false;
    var bestStandardWalk = 0;
    for (final o in options) {
      final c = RouteCandidate(from: o.from, to: o.to, segments: o.segments);
      if (arrivalMinutes(c.segments, departureAt) <= budgetMin &&
          c.walkMinutes > bestStandardWalk) {
        bestStandardWalk = c.walkMinutes;
      }
    }
    return winner.walkMinutes - bestStandardWalk <= _collapseWalkMarginMin;
  }

  /// 乗車駅探索（docs/notes/walk-max-board-search.md / transit-api-migration.md §2.5）。
  /// [base] のコリドー座標を乗車駅候補（前半徒歩 t1 の昇順）とし、各点 X から
  /// `/guidance/plan(X→goal, departureAt+t1)` を引き直して「到着が予算内の最遠＝総徒歩
  /// 最大」を [maxWalkBoardingIndex] で二分探索する。引き直し便は X 発で自己整合なので
  /// `firstMissedTrain` が立たない。コリドー候補は2未満／予算内が無いとき null。
  Future<RouteCandidate?> _buildBoardSearchCandidate(
    TransitOption base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
    DateTime departureAt,
    Map<String, RouteCandidate> walkCache,
  ) async {
    final stops = _corridorStops(base);
    if (stops.length < 2) return null;

    final built = <int, RouteCandidate?>{};
    Future<RouteCandidate?> buildAt(int i) async {
      if (built.containsKey(i)) return built[i];
      final x = stops[i];
      final walk1 = _estimateWalk(
        origin,
        x.coord,
        fromName: base.from,
        toName: '',
      );
      final boardAt = departureAt.add(Duration(minutes: walk1.totalMin));
      final xToGoal = await _fetchTransitFrom(x.coord, goal, boardAt);
      if (xToGoal == null) return built[i] = null;
      final walk1Seg = walk1.segments.first;
      return built[i] = RouteCandidate(
        from: base.from,
        to: xToGoal.to,
        segments: [if (walk1Seg.minutes > 0) walk1Seg, ...xToGoal.segments],
      );
    }

    final best = await maxWalkBoardingIndex(
      count: stops.length,
      budgetMin: budgetMin,
      evaluate: (i) async {
        final c = await buildAt(i);
        return c == null
            ? budgetMin + (1 << 20)
            : arrivalMinutes(c.segments, departureAt);
      },
    );
    if (best == null) return null;

    // 境界付近を実街路 walk で確定（直線は下限のため手前へ後退して実現可能性を上げる）。
    for (var i = best; i >= 0 && best - i < _boardSearchVerifySteps; i--) {
      final x = stops[i];
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
      if (xToGoal == null) continue;
      final walk1Seg = walk1.segments.first;
      final cand = RouteCandidate(
        from: base.from,
        to: xToGoal.to,
        segments: [if (walk1Seg.minutes > 0) walk1Seg, ...xToGoal.segments],
      );
      if (arrivalMinutes(cand.segments, departureAt) <= budgetMin) return cand;
    }
    return null;
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
    final boardDests = [...boardStops, goal];
    final boardRows = await _fetchWalkMatrix([origin], boardDests);
    if (boardRows != null) {
      for (final e in boardRows) {
        if (e is! Map) continue;
        final di = (e['destinationIndex'] as num?)?.toInt() ?? 0;
        final min = _parseDurationMin(e['duration']);
        if (min == null || di < 0 || di >= boardDests.length) continue;
        measured[_walkCacheKey(origin, boardDests[di])] = min;
      }
    }
    if (alightStops.isNotEmpty) {
      final alightRows = await _fetchWalkMatrix(alightStops, [goal]);
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
    final segments = <RouteSegment>[];
    for (final seg in chosen.segments) {
      if (seg.type != SegmentType.walk || seg.polyline.length < 2) {
        segments.add(seg);
        continue;
      }
      final walk = await _tryWalk(
        seg.polyline.first,
        seg.polyline.last,
        fromName: seg.fromName,
        toName: seg.toName,
        cache: cache,
      );
      segments.add(walk?.segments.first ?? seg);
    }
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
      for (final p in _thin(c.coords, _maxCorridorStops)) {
        out.add(_CorridorStop(coord: p, section: c.legIndex, line: line));
      }
    }
    return out;
  }

  /// 座標列を両端を含む均等間隔で最大 [maxCount] 点へ間引く。
  List<GeoPoint> _thin(List<GeoPoint> coords, int maxCount) {
    if (coords.length <= maxCount || maxCount < 2) return coords;
    final out = <GeoPoint>[];
    for (var k = 0; k < maxCount; k++) {
      out.add(coords[(k * (coords.length - 1) / (maxCount - 1)).round()]);
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
    final res = await _transit.get(uri);
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
    final res = await _proxy.get(uri);
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
    final res = await _proxy.get(uri);
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) throw const RouteException('MATRIX_NOT_ARRAY');
    return decoded;
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
