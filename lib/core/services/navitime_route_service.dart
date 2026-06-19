import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'hybrid_route_selector.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';

/// NAVITIME route_transit（プロキシ経由）から、予算内で徒歩を最大化するルートを
/// 生成する。標準乗換経路に加え、途中駅まで歩いて乗車するハイブリッド経路を候補化する。
class NaviTimeRouteService implements RouteService {
  NaviTimeRouteService({
    http.Client? client,
    String? proxyBaseUrl,
    DateTime Function()? clock,
  }) : _client = client ?? http.Client(),
       _clock = clock ?? DateTime.now,
       _proxyBaseUrl = (proxyBaseUrl ?? AppConfig.proxyBaseUrl).replaceAll(
         RegExp(r'/+$'),
         '',
       );

  final http.Client _client;
  final String _proxyBaseUrl;
  final DateTime Function() _clock;

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
    if (_proxyBaseUrl.isEmpty) throw const RouteException('NO_PROXY');
    if (origin == null) throw const RouteException('NO_ORIGIN');
    // NAVITIME route_transit / route_walk は座標が前提（地名のみは非対応）。
    if (destinationLatLng == null) {
      throw const RouteException('NO_DESTINATION');
    }
    final budgetMin = budgetMinutes(departure, arrival);

    onProgress?.call(RoutePhase.routing);

    final body = await _fetchTransit(origin, destinationLatLng, departure);
    final items = body['items'] as List<dynamic>? ?? const [];
    if (items.isEmpty) throw const RouteException('ZERO_RESULTS');

    final parsed = items
        .map((e) => _parseTransit(e as Map<String, dynamic>))
        .toList();

    onProgress?.call(RoutePhase.walkability);

    return _selectMeasured(
      parsed,
      budgetMin,
      departure,
      origin: origin,
      goal: destinationLatLng,
      onProgress: onProgress,
      fromName: originName,
      toName: destination,
    );
  }

  /// 採用候補を enrich（街路実測）で検証して選び直す試行上限。1 試行 = 採用候補1経路
  /// ぶんの enrich／乗り遅れ再照会（#115）。マトリクスが成功した通常ケースは実測値で
  /// 選定済みのため初回で確定し、ここは matrix 失敗時の直線楽観の是正・乗り遅れ差し替え
  /// にのみ働く。上限到達後は楽観評価のまま確定し得る（偽陽性を許す方向）ため安易に
  /// 下げないこと。
  static const int _maxEnrichAttempts = 8;

  /// アクセス徒歩を一括実測するマトリクスの片側（乗車駅集合／降車駅集合）の駅数上限。
  /// 要素数課金（プロキシ側上限 25）を抑えるため [frontierStations] で片側をこの数へ
  /// 絞る。乗車側コールは origin→{各乗車駅, goal} の (上限 + 1) 要素になる。
  static const int _maxMatrixSideStations = 10;

  /// 「測ってから選ぶ」選定（measure-first）。直線フロンティアで乗降候補駅を絞り、
  /// origin→各乗車駅／各降車駅→goal の徒歩を1回（最大2コール）のマトリクスで一括実測
  /// してから、実測値の上で [selectBestRoute] が決定的に予算内徒歩最大を選ぶ。反応的な
  /// 実測ループ・側別迂回率学習・境界帯ヒューリスティックを持たないため、端末↔Function
  /// の往復が畳まれ（最大8回→1〜2回）、座標バリアも直線でなく実測で最初から織り込まれる。
  ///
  /// 標準乗換候補の徒歩は NAVITIME 由来（街路ベースで実測相当）のためそのまま使い、
  /// ハイブリッド／全徒歩のアクセス徒歩だけをマトリクスで実測する。採用候補は街路実測
  /// （enrich）で検証し、予算内候補が予定列車に乗り遅れるなら乗車駅の時刻表を再照会して
  /// 実在列車へ差し替え（#115）、enrich で予算超過が判明したら除外して選び直す（マトリクス
  /// 失敗時の直線楽観の是正・除外は実測の確認時のみ）。マトリクスが成功した通常ケースは
  /// 初回選定が実測と整合し1回で確定する（反応的な迂回率学習・境界帯ヒューリスティックは
  /// 持たない）。予算内候補が無ければ [selectBestRoute] が実到着最早（今夜乗れる範囲）を返す（#121）。
  Future<RoutePlan> _selectMeasured(
    List<_TransitParse> parsed,
    int budgetMin,
    TimeValue departure, {
    required GeoPoint origin,
    required GeoPoint goal,
    void Function(RoutePhase)? onProgress,
    String? fromName,
    String? toName,
  }) async {
    final departureAt = _departureDateTime(departure);
    // 採用1経路の徒歩実測（enrich）をレッグ単位にキャッシュする（#116）。
    final walkCache = <String, RouteCandidate>{};
    // アクセス徒歩の一括実測値（分）をレッグキー単位で持つ。候補生成で参照する。
    final measured = <String, int>{};

    // 標準乗換候補（NAVITIME のアクセス徒歩は街路ベースのためそのまま使う）。
    final candidates = <RouteCandidate>[
      for (final p in parsed) p.toCandidate(),
    ];

    // 停車駅タイムラインを持つ基準経路から乗降候補駅を直線フロンティアで絞り、
    // origin→各乗車駅／各降車駅→goal を一括実測する。全徒歩(origin→goal)は乗車側コール
    // に相乗りさせて同時に実測する。
    final base = _baseForHybrid(parsed);
    if (base != null) {
      final stops = base.stops;
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
        _buildMeasuredHybrids(base, frontier, measured, origin, goal),
      );
    } else {
      // 電車経路が無い（停車駅 < 2）→ 全徒歩のみ実測する。
      await _measureAccessWalks(origin, goal, const [], const [], measured);
    }

    // 全徒歩候補（実測分、無ければ直線推定）。表示名は NAVITIME 解析値を仮置きし、
    // 確定時に _build が実際の出発地・目的地名へ差し替える。
    candidates.add(
      _measuredWalk(origin, goal, parsed.first.from, parsed.first.to, measured),
    );

    // 実測値の上で決定的に選定し、採用候補を enrich（街路実測）で検証する。予算内
    // 見積もりの候補が予定列車に乗り遅れるなら乗車駅の時刻表を再照会して実在列車へ
    // 差し替え（#115）、enrich で予算超過が判明したら（マトリクス失敗時の直線楽観など）
    // 除外して選び直す。除外は実測（enrich・再照会）の確認時だけで、予算内候補がある限り
    // 超過ルートを返さない（#117/#118 の不変条件）。best-effort（予算内なし）は縮小 pool
    // ではなく全 candidates から「今夜乗れる」範囲の実到着最早へ縮退する（#121 原因②）。
    // マトリクスが成功した通常ケースは初回の選定が実測と整合し1回で確定。
    var pool = candidates;
    late RouteCandidate enriched;
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

      // 最善でも予算内に届かない best-effort。ここで縮小 pool の chosen を返すと、enrich
      // 超過で pool から外れた全徒歩などを見落とし「今夜乗れない」翌朝始発を返してしまう
      // （#121 原因②）。全 candidates から「今夜乗れる」範囲（乗車待ち予算内・乗り遅れ無し）
      // の実到着最早へ縮退する。全徒歩は常に reachable なので必ず候補に残る。
      if (!withinByEstimate) {
        final fallbackPool =
            reachableWithinBudget(candidates, budgetMin, departureAt) ??
            candidates;
        final shortest = fallbackPool.reduce(
          (a, b) =>
              arrivalMinutes(a.segments, departureAt) <=
                  arrivalMinutes(b.segments, departureAt)
              ? a
              : b,
        );
        enriched = await _enrichWalkGeometry(shortest, walkCache);
        break;
      }

      // 以降は withinByEstimate（予算内見積もり）の候補のみ。予定列車に乗り遅れるなら
      // 乗車駅の時刻表を NAVITIME へ再照会し実在列車へ差し替えて選び直す（#115）。
      if (attempt < _maxEnrichAttempts) {
        final missed = firstMissedTrain(chosen.segments, departureAt);
        if (missed != null) {
          final real = await _refetchMissedTrain(
            chosen,
            missed,
            goal,
            departureAt,
          );
          if (real != null) {
            // 実在列車の発着で差し替え（real は乗り遅れ無しが保証される）。
            pool = [for (final c in pool) identical(c, chosen) ? real : c];
            continue;
          }
          // 実在の後続列車を確認できない → 当該候補を除外して選び直す。
          if (pool.length > 1) {
            pool = pool.where((c) => !identical(c, chosen)).toList();
            continue;
          }
        }
      }

      // 採用1経路の徒歩区間だけ Google の街路ジオメトリ・所要・距離へ上書きする。
      enriched = await _enrichWalkGeometry(chosen, walkCache);

      // 予算内見積もりが enrich（実測）で超過に転じたら除外して次善へ（matrix 失敗時の
      // 直線楽観の是正）。除外は実測の確認時だけで、予算内候補がある限り超過を返さない
      // （#117/#118 の不変条件）。
      if (attempt < _maxEnrichAttempts &&
          pool.length > 1 &&
          arrivalMinutes(enriched.segments, departureAt) > budgetMin) {
        pool = pool.where((c) => !identical(c, chosen)).toList();
        continue;
      }
      break;
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

  /// 乗降アクセス徒歩を1回（最大2コール）のマトリクスで一括実測し、[measured] に
  /// レッグキー→徒歩分で格納する。乗車側 origin→{各乗車駅, goal}・降車側 {各降車駅}→goal。
  /// goal を乗車側 destinations 末尾に相乗りさせ全徒歩(origin→goal)も同時に測る。マトリクス
  /// 失敗（null）のレッグは未格納のまま（候補生成側が直線推定へフォールバックする）。
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

  /// フロンティアの乗車駅 b → 降車駅 a（同一 section・b より後方）の全分割を、実測した
  /// アクセス徒歩で候補化する。乗車時間・距離・運賃は [_rideMinutes]/[_railKm]/
  /// [_proratedFare] で求める（直線推定の旧 _buildHybrids を実測版に置換したもの）。
  List<RouteCandidate> _buildMeasuredHybrids(
    _TransitParse base,
    ({List<int> boarding, List<int> alighting}) frontier,
    Map<String, int> measured,
    GeoPoint origin,
    GeoPoint goal,
  ) {
    final stops = base.stops;
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
        // 乗換をまたぐ b→a は単一乗車として表現できないため同一区間のペアのみ。
        if (stops[a].section != stops[b].section) continue;
        final ride = _rideMinutes(stops, b, a);
        if (ride < 0) continue;
        final walk2 = _measuredWalkSeg(
          stops[a].coord,
          goal,
          stops[a].name,
          base.to,
          measured,
        );
        final rideKm = _railKm(stops, b, a);
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
                fare: _proratedFare(stops, b, a, rideKm),
                stops: a - b,
                depTime: stops[b].dep,
                arrTime: stops[a].arr,
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
  /// 距離・kcal・polyline 端点は直線推定値を仮置きし、採用されれば [_enrichWalkGeometry]
  /// が街路実測へ上書きする（選定は徒歩分のみで足り、表示値は確定時に取り直すため）。
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
    // 端点がほぼ同一（直線で 0 分）のレッグは徒歩 0。降車駅＝目的地・乗車駅＝出発地の
    // ように座標が一致する退化レッグで、実測の丸めや概算値が幽霊徒歩を生むのを防ぐ。
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

  /// computeRouteMatrix（徒歩）をプロキシ経由で叩き、要素配列を返す。
  /// origins/destinations はセミコロン区切りの "lat,lng" 列。失敗（HTTP 異常・
  /// 配列でない応答・通信失敗）は null（呼び出し側が逐次プローブへフォールバック）。
  Future<List<dynamic>?> _fetchWalkMatrix(
    List<GeoPoint> origins,
    List<GeoPoint> dests,
  ) async {
    String join(List<GeoPoint> ps) =>
        ps.map((p) => '${p.lat},${p.lng}').join(';');
    try {
      return await _fetchArray('googleWalkMatrixProxy', {
        'origins': join(origins),
        'destinations': join(dests),
      });
    } on RouteException {
      return null;
    }
  }

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要時間・距離で
  /// 上書きする。標準乗換候補の徒歩は NAVITIME 由来（shape 無し→端点直線）の
  /// ため、区間端点（polyline の両端）を start/goal に再取得して街路追従へそろえる。
  /// 取得失敗時は元の直線を保つ（線を欠落させない）。座標を持たない区間は対象外。
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

  /// 確定しかけた候補 [enriched] の乗り遅れ電車区間 [missed] を、乗車駅からの時刻表を
  /// NAVITIME に再照会して実在列車の発着時刻へ差し替える（#115）。乗車駅座標は当該
  /// 区間 polyline の先頭、再照会の出発時刻は出発 [departureAt] + 駅着までの実累積分。
  /// 同一路線・同一降車駅を含み、駅着以降に発車する実在列車が見つかればその dep/arr で
  /// 区間を差し替えた候補を返す。見つからなければ null（呼び出し側が候補を除外し次善へ）。
  /// 運賃・距離・polyline・停車数は元の按分値を保ち、発着時刻と乗車時間だけ実データへ。
  Future<RouteCandidate?> _refetchMissedTrain(
    RouteCandidate enriched,
    ({int index, int cumBefore}) missed,
    GeoPoint goal,
    DateTime departureAt,
  ) async {
    final train = enriched.segments[missed.index];
    if (train.polyline.isEmpty) return null;
    final board = train.polyline.first;
    final startTime = departureAt.add(Duration(minutes: missed.cumBefore));

    final Map<String, dynamic> body;
    try {
      body = await _fetchTransitAt(board, goal, startTime);
    } on RouteException {
      return null;
    }
    final items = (body['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
    final real = _findRealBoarding(
      items,
      line: train.line,
      boardName: train.fromName,
      alightName: train.toName,
      notBefore: startTime,
    );
    if (real == null) return null;
    final ride = _minutesBetween(real.arr, real.dep);
    if (ride < 0) return null;

    final replaced = RouteSegment(
      type: SegmentType.train,
      fromName: train.fromName,
      toName: train.toName,
      minutes: ride,
      km: train.km,
      line: train.line,
      fare: train.fare,
      stops: train.stops,
      polyline: train.polyline,
      depTime: real.dep,
      arrTime: real.arr,
    );
    final segments = [
      for (var i = 0; i < enriched.segments.length; i++)
        if (i == missed.index) replaced else enriched.segments[i],
    ];
    // 多区間経路で最初の乗り遅れ区間を遅い実在列車へ差し替えると、再照会していない
    // 下流の電車区間が借用時刻表のまま乗り遅れ（接続崩れ）になり得る。その場合は
    // 楽観評価（_advance の待ち0・同乗車時間近似）で下流を確定しないよう候補ごと
    // 除外し、呼び出し側の次善フォールバックに委ねる（乗れない列車を確定しない）。
    // ハイブリッドは単一電車のためここは常に null（差し替え1区間で完結する）。
    if (firstMissedTrain(segments, departureAt) != null) return null;
    return RouteCandidate(
      from: enriched.from,
      to: enriched.to,
      segments: segments,
    );
  }

  /// 再照会レスポンス [items] から、乗車駅 [boardName]（同一路線 [line]）を [notBefore]
  /// 以降に発車し、同一乗車区間内で降車駅 [alightName] に停車する実在列車の発着時刻を
  /// 探す。MVP は別路線・別降車駅の経路を採らず、見つからなければ null（候補を除外）。
  /// [notBefore] より前に発車する列車（＝駅着前に出てしまい乗れない）は除外する。
  /// [items] は route_transit が最早接続を先頭に返す前提で、最初に条件を満たした列車を
  /// 採る（dep でソートし直さない）。順序が崩れると最早でない列車を拾い不要な
  /// フォールバックを招き得るが、乗れない列車は確定しないため正確性は保たれる。
  ({DateTime dep, DateTime arr})? _findRealBoarding(
    List<Map<String, dynamic>> items, {
    required String? line,
    required String boardName,
    required String alightName,
    required DateTime notBefore,
  }) {
    for (final item in items) {
      final stops = _parseTransit(item).stops;
      for (var b = 0; b < stops.length; b++) {
        final boarding = stops[b];
        if (boarding.name != boardName || boarding.dep == null) continue;
        if (line != null && boarding.line != line) continue;
        if (boarding.dep!.isBefore(notBefore)) continue;
        for (var a = b + 1; a < stops.length; a++) {
          final alighting = stops[a];
          // 同一乗車区間を外れたら（乗換）この乗車では a へ行けない。
          if (alighting.section != boarding.section) break;
          if (alighting.name == alightName && alighting.arr != null) {
            return (dep: boarding.dep!, arr: alighting.arr!);
          }
        }
      }
    }
    return null;
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
      // アプリが持つ実際の出発地・目的地名を優先する。NAVITIME は座標問い合わせ
      // だと地点名を "start"/"goal" で返すため、解析値はフォールバックに留める。
      from: _displayName(fromName, chosen.from),
      to: _displayName(toName, chosen.to),
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
      departureAt: departureAt,
    );
  }

  /// 表示名を決める。アプリ由来の [override] が空でなければそれを、無ければ
  /// NAVITIME 解析値 [fallback] を使う。
  String _displayName(String? override, String fallback) {
    final name = override?.trim();
    return (name != null && name.isNotEmpty) ? name : fallback;
  }

  /// 停車駅タイムラインを持つ最短の標準経路をハイブリッドの基準にする。
  _TransitParse? _baseForHybrid(List<_TransitParse> parsed) {
    _TransitParse? best;
    for (final p in parsed) {
      if (p.stops.length < 2) continue;
      if (best == null || p.totalMin < best.totalMin) best = p;
    }
    return best;
  }

  /// 乗車区間 [b]→[a] の所要時間（分）。両端の発着時刻が揃えば時刻表の差を使い、
  /// どちらかが欠落していれば停車駅折れ線長を [trainMetersPerMinute] で割って概算する
  /// （calling_at の時刻欠落でハイブリッドを取りこぼさないため #67）。
  int _rideMinutes(List<_Stop> stops, int b, int a) {
    final dep = stops[b].dep;
    final arr = stops[a].arr;
    if (dep != null && arr != null) return _minutesBetween(arr, dep);
    return (_railKm(stops, b, a) * 1000 / trainMetersPerMinute).round();
  }

  /// 乗車区間 [b]→[a]（同一区間・連続インデックス）の距離概算。途中停車駅を
  /// 結ぶ折れ線長で、始終点の直線距離より実鉄道距離に近い値を返す。
  double _railKm(List<_Stop> stops, int b, int a) {
    var km = 0.0;
    for (var i = b; i < a; i++) {
      km += haversineKm(stops[i].coord, stops[i + 1].coord);
    }
    return km;
  }

  /// ハイブリッド乗車区間 [b]→[a]（鉄道距離 [rideKm]）の運賃。セクション全体の
  /// 運賃を、乗車区間の鉄道距離 ÷ セクション全体の鉄道距離で按分する（途中駅から
  /// 短く乗る場合に全区間運賃をそのまま使うと過大になるため #71）。運賃が取得
  /// できない区間やセクション距離が 0 の場合はセクション運賃をそのまま返す（null
  /// も許容）。同一 section は stops 配列上で連続している前提で前後に拡張する。
  int? _proratedFare(List<_Stop> stops, int b, int a, double rideKm) {
    final fare = stops[b].fare;
    if (fare == null) return null;
    final section = stops[b].section;
    var first = b;
    var last = a;
    while (first > 0 && stops[first - 1].section == section) {
      first--;
    }
    while (last < stops.length - 1 && stops[last + 1].section == section) {
      last++;
    }
    final fullKm = _railKm(stops, first, last);
    if (fullKm <= 0) return fare;
    return (fare * rideKm / fullKm).round();
  }

  Future<Map<String, dynamic>> _fetchTransit(
    GeoPoint origin,
    GeoPoint goal,
    TimeValue departure,
  ) => _fetchTransitAt(origin, goal, _departureDateTime(departure));

  /// 乗車駅などの絶対時刻 [startTime] を起点に route_transit を引く（乗り遅れ再照会
  /// #115 と通常照会の共通経路）。クエリは [_fetchTransit] と同形で start_time だけ
  /// 任意の絶対時刻に差し替える。
  Future<Map<String, dynamic>> _fetchTransitAt(
    GeoPoint start,
    GeoPoint goal,
    DateTime startTime,
  ) => _fetch('navitimeProxy', {
    'start': '${start.lat},${start.lng}',
    'goal': '${goal.lat},${goal.lng}',
    'start_time': _formatStartTime(startTime),
    'options': 'railway_calling_at',
    'shape': 'true',
  });

  /// origin→dest を直線距離から推定した徒歩区間候補にする（API 呼び出しなし）。
  /// 候補選定フェーズ用。確定経路に選ばれれば [_enrichWalkGeometry] が Google の
  /// 街路追従ジオメトリ・所要時間・距離へ上書きする。polyline は端点直線。
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

  /// origin→dest の徒歩を Google Routes API（computeRoutes, travelMode=WALK,
  /// プロキシ経由）で取得して単一の徒歩区間候補にする。NAVITIME は徒歩 shape を
  /// 返さないため、街路追従ジオメトリは Google から得る。所要時間・距離も同一
  /// レスポンスから取り、徒歩区間の値を Google に統一する。
  /// 失敗時は null（標準経路へ縮退）。
  Future<RouteCandidate?> _tryWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
    Map<String, RouteCandidate>? cache,
  }) async {
    // レッグ単位キャッシュ（#116）。座標を 5 桁（≒1.1m）に丸めた文字列キーで引く。
    // ヒット時は実測ジオメトリ・所要・距離を再利用しつつ、表示名は要求側（候補側）の
    // fromName/toName へ差し替える（同一座標でも候補により表示名は異なり得る）。
    if (cache != null) {
      final key = _walkCacheKey(origin, dest);
      final hit = cache[key];
      if (hit != null) return _renameWalk(hit, fromName, toName);
    }
    try {
      final body = await _fetch('googleWalkProxy', {
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
            // polyline が無ければ origin→dest を直線で結ぶ。
            polyline: shape.isNotEmpty ? shape : [origin, dest],
          ),
        ],
      );
      // 実測成功のみキャッシュ。失敗（下の null 返却）は負キャッシュしないため、
      // 一時的なネットワーク失敗が検索全体へ波及しない（同一レッグは再試行され得る）。
      if (cache != null) cache[_walkCacheKey(origin, dest)] = result;
      return result;
    } on RouteException {
      return null;
    }
  }

  /// 徒歩実測キャッシュのキー。座標の浮動小数同値性に依存しないよう小数5桁
  /// （≒1.1m 精度）へ丸めた start|goal 文字列にする。
  String _walkCacheKey(GeoPoint origin, GeoPoint dest) =>
      '${origin.lat.toStringAsFixed(5)},${origin.lng.toStringAsFixed(5)}'
      '|${dest.lat.toStringAsFixed(5)},${dest.lng.toStringAsFixed(5)}';

  /// キャッシュ済み徒歩区間 [cached] を、要求側の表示名 [fromName]/[toName] で
  /// 差し替えた候補にする。実測値（所要・距離・kcal・polyline）はそのまま再利用する。
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

  /// Google Routes の duration（"123s" 形式の文字列）を分へ丸める。
  int? _parseDurationMin(Object? duration) {
    if (duration is! String) return null;
    final seconds = int.tryParse(duration.replaceAll('s', ''));
    if (seconds == null) return null;
    return (seconds / 60).round();
  }

  /// Google Routes の polyline.encodedPolyline をデコードして座標列にする。
  /// decodePolyline は [lat, lng] 順のペアを返す。
  List<GeoPoint> _parseEncodedPolyline(Object? polyline) {
    final encoded = polyline is Map ? polyline['encodedPolyline'] : null;
    if (encoded is! String || encoded.isEmpty) return const [];
    return [
      for (final p in decodePolyline(encoded))
        GeoPoint(p[0].toDouble(), p[1].toDouble()),
    ];
  }

  Future<Map<String, dynamic>> _fetch(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// JSON 配列を返すエンドポイント（computeRouteMatrix プロキシ #118）用の取得。
  /// 200 以外・配列でない応答は [RouteException]（呼び出し側でフォールバック）。
  Future<List<dynamic>> _fetchArray(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) throw const RouteException('MATRIX_NOT_ARRAY');
    return decoded;
  }

  _TransitParse _parseTransit(Map<String, dynamic> item) {
    final sections = (item['sections'] as List<dynamic>)
        .cast<Map<String, dynamic>>();
    final points = sections.where((s) => s['type'] == 'point').toList();
    final from = points.isNotEmpty
        ? (points.first['name'] as String? ?? '出発地')
        : '出発地';
    final to = points.isNotEmpty
        ? (points.last['name'] as String? ?? '目的地')
        : '目的地';

    String nameAt(int i) => sections[i]['name'] as String? ?? '';

    final segments = <RouteSegment>[];
    final stops = <_Stop>[];
    var trainSection = 0;

    for (var i = 0; i < sections.length; i++) {
      final sec = sections[i];
      if (sec['type'] != 'move') continue;
      final meters = (sec['distance'] as num?)?.toInt() ?? 0;
      final minutes = (sec['time'] as num?)?.toInt() ?? 0;
      final km = meters / 1000.0;
      final fromName = i > 0 ? nameAt(i - 1) : from;
      final toName = i + 1 < sections.length ? nameAt(i + 1) : to;

      // shape（街路追従ジオメトリ）が無い場合に備え、前後の point 座標を控える。
      final prevCoord = i > 0 ? _coordOf(sections[i - 1]) : null;
      final nextCoord = i + 1 < sections.length
          ? _coordOf(sections[i + 1])
          : null;
      final shape = _parseShape(sec);

      if (sec['move'] == 'walk') {
        segments.add(
          RouteSegment(
            type: SegmentType.walk,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            kcal: (km * kcalPerKm).round(),
            // shape が無ければ区間端点を直線で結ぶ。
            polyline: shape.isNotEmpty
                ? shape
                : _lineFrom([prevCoord, nextCoord]),
          ),
        );
      } else {
        final line = sec['line_name'] as String?;
        final sectionStops = _parseCalling(sec, line, trainSection);
        stops.addAll(sectionStops);
        trainSection++;
        // shape が無ければ停車駅(calling_at)座標、それも無ければ端点で代替。
        final calling = _callingCoords(sec);
        // 乗車駅発・降車駅着の絶対時刻でタイムラインの乗車前・乗換待ちを反映する（#65）。
        // 実 API の calling_at は途中通過駅のみで乗降駅を含まないため、乗降時刻は move
        // セクション直下の from_time/to_time が正値（calling_at 先頭/末尾を使うと
        // 「乗車駅→1駅目」「最終途中駅→降車駅」のぶん早まる）。move 直下が欠落した
        // ときのみ calling_at の先頭 dep・末尾 arr へフォールバックする。
        final moveDep = parseNavitimeJst(sec['from_time'] as String?);
        final moveArr = parseNavitimeJst(sec['to_time'] as String?);
        segments.add(
          RouteSegment(
            type: SegmentType.train,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            line: line,
            stops: (sec['stop_count'] as num?)?.toInt(),
            fare: _fareOf(sec),
            depTime:
                moveDep ??
                (sectionStops.isNotEmpty ? sectionStops.first.dep : null),
            arrTime:
                moveArr ??
                (sectionStops.isNotEmpty ? sectionStops.last.arr : null),
            polyline: shape.isNotEmpty
                ? shape
                : (calling.length >= 2
                      ? calling
                      : _lineFrom([prevCoord, nextCoord])),
          ),
        );
      }
    }

    return _TransitParse(from: from, to: to, segments: segments, stops: stops);
  }

  /// 電車区間の停車駅（座標を持つもの）を順序通りに取得する。発着時刻は欠落しても
  /// 座標があれば残す（プロキシ/RapidAPI 由来データは時刻が欠けることがあり、それで
  /// 停車駅を捨てるとハイブリッド候補が生成されず予算が余る #67 の再発要因になる）。
  /// 時刻が無い区間の乗車時間は [_rideMinutes] が距離から概算する。
  /// [line] はその区間から乗車する際の路線名、[section] は乗車区間の通し番号
  /// （乗換をまたぐペアを除外するために用いる）。
  List<_Stop> _parseCalling(
    Map<String, dynamic> trainSec,
    String? line,
    int section,
  ) {
    final transport = trainSec['transport'];
    final raw =
        (transport is Map ? transport['calling_at'] : null) ??
        trainSec['calling_at'];
    if (raw is! List) return const [];

    // セクション運賃は全停車駅で共通。ハイブリッドの距離按分の基準にする。
    final sectionFare = _fareOf(trainSec);
    final out = <_Stop>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final coord = e['coord'];
      final lat = coord is Map ? (coord['lat'] as num?)?.toDouble() : null;
      final lon = coord is Map
          ? ((coord['lon'] as num?) ?? (coord['lng'] as num?))?.toDouble()
          : null;
      if (lat == null || lon == null) continue;
      out.add(
        _Stop(
          name: e['name'] as String? ?? '',
          coord: GeoPoint(lat, lon),
          arr: parseNavitimeJst(e['from_time'] as String?),
          dep: parseNavitimeJst(e['to_time'] as String?),
          line: line,
          section: section,
          fare: sectionFare,
        ),
      );
    }
    return out;
  }

  /// move セクションの shape（GeoJSON LineString）を座標列へ変換する。
  /// NAVITIME は coordinates を [lng, lat] 順で返す。未知形状は空（地図線なし）。
  List<GeoPoint> _parseShape(Map<String, dynamic> section) {
    final shape = section['shape'];
    final coords = shape is Map ? shape['coordinates'] : shape;
    if (coords is! List) return const [];
    final out = <GeoPoint>[];
    for (final c in coords) {
      if (c is List && c.length >= 2) {
        final lng = (c[0] as num?)?.toDouble();
        final lat = (c[1] as num?)?.toDouble();
        if (lat != null && lng != null) out.add(GeoPoint(lat, lng));
      } else if (c is Map) {
        final lat = (c['lat'] as num?)?.toDouble();
        final lng = ((c['lon'] as num?) ?? (c['lng'] as num?))?.toDouble();
        if (lat != null && lng != null) out.add(GeoPoint(lat, lng));
      }
    }
    return out;
  }

  /// point セクション等の coord（{lat, lon|lng}）を GeoPoint へ変換する。
  GeoPoint? _coordOf(Map<String, dynamic> section) {
    final c = section['coord'];
    if (c is! Map) return null;
    final lat = (c['lat'] as num?)?.toDouble();
    final lon = ((c['lon'] as num?) ?? (c['lng'] as num?))?.toDouble();
    if (lat == null || lon == null) return null;
    return GeoPoint(lat, lon);
  }

  /// move（電車）セクションの運賃を取り出す。NAVITIME は運賃を
  /// `section.transport.fare` に格納する（calling_at と同じ階層）。互換のため
  /// section 直下の fare も後方で参照する。
  int? _fareOf(Map<String, dynamic> section) {
    final transport = section['transport'];
    final fare = transport is Map ? transport['fare'] : null;
    return _parseFare(fare ?? section['fare']);
  }

  /// NAVITIME の運賃は数値ではなく「unit_{料金区分ID}」をキーに持つオブジェクト
  /// （例: {"unit_0": 170, "unit_48": 165}）で返る。unit_48 が IC カード運賃、
  /// unit_0 が普通(きっぷ)運賃。IC 運賃を優先し、無ければ普通運賃、いずれも
  /// 無ければ最初に見つかった数値の運賃区分を採る。古い想定どおり数値で来た
  /// 場合にも備える。取り出せなければ null（運賃非表示）。
  int? _parseFare(dynamic fare) {
    if (fare is num) return fare.toInt();
    if (fare is Map) {
      for (final key in const ['unit_48', 'unit_0']) {
        final v = fare[key];
        if (v is num) return v.toInt();
      }
      for (final v in fare.values) {
        if (v is num) return v.toInt();
      }
    }
    return null;
  }

  /// move（電車）セクションの calling_at 駅座標を順序通りに取得する。
  /// shape が無いときの代替ジオメトリ（折れ線）に用いる。
  ///
  /// [_parseCalling] とは目的が異なり、こちらは _Stop を作らず座標だけを集める。
  /// どちらも時刻が欠落した駅でも座標があれば残す（[_parseCalling] の時刻欠落駅は
  /// 所要時間を [_rideMinutes] が距離から概算する）。
  List<GeoPoint> _callingCoords(Map<String, dynamic> sec) {
    final transport = sec['transport'];
    final raw =
        (transport is Map ? transport['calling_at'] : null) ??
        sec['calling_at'];
    if (raw is! List) return const [];
    final out = <GeoPoint>[];
    for (final e in raw) {
      if (e is Map<String, dynamic>) {
        final p = _coordOf(e);
        if (p != null) out.add(p);
      }
    }
    return out;
  }

  /// null を除いた座標が2点以上あれば折れ線（直線）にする。1点以下は空。
  List<GeoPoint> _lineFrom(List<GeoPoint?> points) {
    final out = [for (final p in points) ?p];
    return out.length >= 2 ? out : const [];
  }

  int _minutesBetween(DateTime later, DateTime earlier) =>
      (later.difference(earlier).inSeconds / 60).round();

  /// 出発の絶対時刻。dateOffset（isNow→0）で日付を決定する。NAVITIME の
  /// 時刻表（calling_at の from_time/to_time）と同じ基準でタイムラインの
  /// 待ち時間を算出するための基点に使う（#65）。
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

  /// 絶対時刻を NAVITIME の start_time（ISO8601・秒0固定）へ整形する。
  /// NAVITIME route_transit はタイムゾーンオフセット付きの start_time を受け付けず
  /// `parameter error` を返す（#121 で +09:00 を付けたところ全検索が 502 化した）。
  /// オフセットは元々不要：[_departureDateTime] は TZ 変換をせずユーザーが選んだ
  /// wall-clock の時・分をそのまま構成要素に持つため、ここで出力する数字は選択時刻
  /// そのもの。日本の公共交通ダイヤを引く NAVITIME はこれを JST として解釈するので、
  /// JST 以外の端末でも終電後判定はずれない。
  String _formatStartTime(DateTime dt) {
    final y = dt.year.toString().padLeft(4, '0');
    final mo = dt.month.toString().padLeft(2, '0');
    final d = dt.day.toString().padLeft(2, '0');
    final h = dt.hour.toString().padLeft(2, '0');
    final mi = dt.minute.toString().padLeft(2, '0');
    return '$y-$mo-${d}T$h:$mi:00';
  }
}

/// NAVITIME の時刻文字列（calling_at の from_time/to_time）を「JST の wall-clock を
/// 表す naive DateTime」へ正規化する（#121 TZ）。
///
/// 実 API は時刻に `+09:00` を付けて返し、[DateTime.parse] はそれを UTC インスタンス
/// （isUtc=true）にする。一方タイムラインの出発アンカー（[NaviTimeRouteService.
/// _departureDateTime]）はユーザー選択の壁時計値そのものを持つ naive DateTime で、
/// この両者を [DateTime.difference] すると端末 TZ ぶんずれる。JST 以外の端末では
/// 乗車待ちが負＝0 に化け、翌朝始発が「今すぐ乗れる深夜電車」として #121② の
/// フィルタを素通りしていた（深夜時刻表示の主因）。
///
/// NAVITIME のダイヤは常に JST。オフセット/Z 付き（[DateTime.isUtc]）なら +9h して
/// JST の壁時計成分を読み取り、オフセット無し（naive）なら数字をそのまま JST 壁時計と
/// みなす。いずれも isUtc=false の naive DateTime を返すため、同じく naive な出発
/// アンカーとの差分が端末 TZ に依存しなくなる。解析不能・null・空は null。
@visibleForTesting
DateTime? parseNavitimeJst(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  final dt = DateTime.tryParse(raw);
  if (dt == null) return null;
  final jst = dt.isUtc ? dt.add(const Duration(hours: 9)) : dt;
  return DateTime(
    jst.year,
    jst.month,
    jst.day,
    jst.hour,
    jst.minute,
    jst.second,
  );
}

/// 直線距離で乗降候補駅を片側 [maxPerSide] 個へ絞る（measure-first のフロンティア
/// 絞り込み）。乗車側は origin→駅、降車側は 駅→goal の直線徒歩分を見て、その**直線徒歩が
/// 予算 [budgetMin] 内**の駅だけを feasible とする。直線（haversine）は実際の道なり徒歩の
/// 下限なので、直線ですら予算を超える駅は実測しても確実に予算外＝測る価値がない。逆に
/// 直線が予算内なら、予算の大半を1本のアクセス徒歩に使う候補（短い乗車＋長い徒歩）も
/// 残すため、ここでは道なり迂回の割増を掛けない（掛けると徒歩最大の正当な候補を誤って
/// 落とす）。
///
/// feasible な駅が [maxPerSide] を超えるときは**均等間隔で間引く（両端を含む）**。徒歩分の
/// 大きい順 top-K で間引くと、乗車側＝origin から遠い駅・降車側＝goal から遠い駅という
/// **互いに逆相関**の集合になり、同一 section・b<a の乗降ペアが作れず「中間駅で短く乗り
/// 両端を長く歩く」徒歩最大候補（ride-one-stop）を取りこぼす。両端＋中間を均等に残せば、
/// 長い片側徒歩の候補（両端）も ride-one-stop（中間）も拾い、両側のインデックス域が重なって
/// b<a ペアを保てる。駅配列の昇順インデックスで返す（下流が同一 section・b<a の乗降ペアを
/// 作るため元の順序を保つ）。
///
/// これにより origin→各乗車駅／各降車駅→goal を1回のマトリクスで一括実測する対象を
/// 要素数課金（片側 ≤ [maxPerSide]）の範囲へ抑えつつ、徒歩最大の乗降候補を取りこぼさない。
/// Google を呼ばない純粋関数。
@visibleForTesting
({List<int> boarding, List<int> alighting}) frontierStations(
  List<GeoPoint> stops,
  GeoPoint origin,
  GeoPoint goal,
  int budgetMin, {
  int maxPerSide = 10,
}) {
  int walkMin(GeoPoint a, GeoPoint b) =>
      (haversineKm(a, b) * 1000 / walkMetersPerMinute).round();

  List<int> pick(int Function(int i) sideWalk) {
    final feasible = <int>[
      for (var i = 0; i < stops.length; i++)
        if (sideWalk(i) <= budgetMin) i,
    ];
    if (feasible.length <= maxPerSide || maxPerSide < 2) {
      return feasible.take(maxPerSide).toList();
    }
    // 均等間隔で maxPerSide 個（両端を含む）。中間駅を残して b<a の乗降ペアを保つ。
    final out = <int>{};
    for (var k = 0; k < maxPerSide; k++) {
      out.add(feasible[(k * (feasible.length - 1) / (maxPerSide - 1)).round()]);
    }
    return out.toList()..sort();
  }

  return (
    boarding: pick((i) => walkMin(origin, stops[i])),
    alighting: pick((i) => walkMin(stops[i], goal)),
  );
}

/// 解析済みの標準乗換経路。ハイブリッド構築に必要な停車駅タイムラインを保持する。
class _TransitParse {
  _TransitParse({
    required this.from,
    required this.to,
    required this.segments,
    required this.stops,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;

  /// 経路上の全電車区間の停車駅を出発側から順に並べたもの。
  final List<_Stop> stops;

  int get totalMin => segments.fold(0, (a, s) => a + s.minutes);

  RouteCandidate toCandidate() =>
      RouteCandidate(from: from, to: to, segments: segments);
}

/// 経路上の停車駅。乗車・降車の候補点になる。
class _Stop {
  _Stop({
    required this.name,
    required this.coord,
    required this.arr,
    required this.dep,
    required this.line,
    required this.section,
    required this.fare,
  });

  final String name;
  final GeoPoint coord;

  /// この駅への到着時刻（降車に使用）。calling_at に時刻が無ければ null。
  final DateTime? arr;

  /// この駅からの発車時刻（乗車に使用）。calling_at に時刻が無ければ null。
  final DateTime? dep;

  /// この駅から乗車する際の路線名。
  final String? line;

  /// この駅が属する乗車区間の通し番号。乗換をまたぐ駅は番号が異なる。
  /// 同一 section の駅は stops 配列上で連続する（運賃按分が前提にする不変条件）。
  final int section;

  /// この駅が属する乗車区間（セクション）全体の運賃。ハイブリッドの一部区間
  /// 運賃を距離按分するための基準。取得できなければ null。
  final int? fare;
}
