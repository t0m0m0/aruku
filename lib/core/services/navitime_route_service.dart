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

  /// ハイブリッド候補の評価駅数の上限（組合せ爆発を抑えるサンプル数）。
  static const int _maxHybridCandidates = 6;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
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

    final candidates = <RouteCandidate>[
      for (final p in parsed) p.toCandidate(),
    ];

    // 全徒歩。予算内なら徒歩 100% が最良のためハイブリッド探索を省く。
    // 選定フェーズの徒歩は直線距離ベースの推定（Google を呼ばない）。
    final fullWalk = _estimateWalk(
      origin,
      destinationLatLng,
      fromName: parsed.first.from,
      toName: parsed.first.to,
    );
    candidates.add(fullWalk);
    if (fullWalk.totalMin <= budgetMin) {
      return _finalize(
        selectBestRoute(
          candidates: candidates,
          budgetMin: budgetMin,
          origin: origin,
          goal: destinationLatLng,
        ),
        departure,
        budgetMin,
        onProgress,
      );
    }

    // 途中駅まで歩いて乗車するハイブリッド候補を追加する。
    final base = _baseForHybrid(parsed);
    if (base != null) {
      candidates.addAll(_buildHybrids(base, origin, destinationLatLng));
    }

    return _finalize(
      selectBestRoute(
        candidates: candidates,
        budgetMin: budgetMin,
        origin: origin,
        goal: destinationLatLng,
      ),
      departure,
      budgetMin,
      onProgress,
    );
  }

  /// 確定経路を RoutePlan へ。選定は直線距離ベースの推定で行うため、表示する
  /// 1 経路ぶんの徒歩区間だけ Google Routes で街路追従ジオメトリ・所要時間・
  /// 距離に上書きする（Google 呼び出しは採用経路の徒歩区間数ぶんのみ）。
  Future<RoutePlan> _finalize(
    RouteCandidate chosen,
    TimeValue departure,
    int budgetMin,
    void Function(RoutePhase)? onProgress,
  ) async {
    final route = await _enrichWalkGeometry(chosen);
    return _build(route, departure, budgetMin, onProgress);
  }

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要時間・距離で
  /// 上書きする。標準乗換候補の徒歩は NAVITIME 由来（shape 無し→端点直線）の
  /// ため、区間端点（polyline の両端）を start/goal に再取得して街路追従へそろえる。
  /// 取得失敗時は元の直線を保つ（線を欠落させない）。座標を持たない区間は対象外。
  Future<RouteCandidate> _enrichWalkGeometry(RouteCandidate chosen) async {
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
      );
      segments.add(walk?.segments.first ?? seg);
    }
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segments);
  }

  RoutePlan _build(
    RouteCandidate chosen,
    TimeValue departure,
    int budgetMin,
    void Function(RoutePhase)? onProgress,
  ) {
    onProgress?.call(RoutePhase.building);
    return buildRoutePlan(
      from: chosen.from,
      to: chosen.to,
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
      departureAt: _departureDateTime(departure),
    );
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

  /// 基準経路の停車駅から「乗車駅 b → 降車駅 a（b より後方）」の全分割を候補化する。
  /// 各駅の origin→駅 / 駅→goal 徒歩は直線距離ベースで推定（Google を呼ばない）し、
  /// 乗車時間は [_rideMinutes]（時刻表の差、無ければ距離から概算）で求める。
  /// これにより乗車を後ろ倒し（徒歩を増やす）したり、
  /// 手前で降りて目的地まで歩く候補が同じ土俵に並ぶ。生成する候補は
  /// [_maxHybridCandidates] 駅のサンプルで組合せ爆発を抑える。
  List<RouteCandidate> _buildHybrids(
    _TransitParse base,
    GeoPoint origin,
    GeoPoint goal,
  ) {
    final stops = base.stops;
    final indices = _sampleIndices(stops.length, _maxHybridCandidates);

    // 各停車駅の origin→駅 / 駅→goal 徒歩を直線距離から推定する。
    final fromOrigin = <int, RouteSegment>{
      for (final i in indices)
        i: _estimateWalk(
          origin,
          stops[i].coord,
          fromName: base.from,
          toName: stops[i].name,
        ).segments.first,
    };
    final toGoal = <int, RouteSegment>{
      for (final i in indices)
        i: _estimateWalk(
          stops[i].coord,
          goal,
          fromName: stops[i].name,
          toName: base.to,
        ).segments.first,
    };

    final result = <RouteCandidate>[];
    for (final b in indices) {
      final walk1 = fromOrigin[b]!;
      for (final a in indices) {
        if (a <= b) continue;
        // 乗換をまたぐ b→a は単一乗車として表現できない（路線・乗換・運賃を
        // 誤る）ため、同一乗車区間内のペアのみ候補化する。
        if (stops[a].section != stops[b].section) continue;
        final walk2 = toGoal[a]!;
        final ride = _rideMinutes(stops, b, a);
        if (ride < 0) continue;
        final segments = <RouteSegment>[
          if (walk1.minutes > 0) walk1,
          RouteSegment(
            type: SegmentType.train,
            fromName: stops[b].name,
            toName: stops[a].name,
            minutes: ride,
            km: _railKm(stops, b, a),
            line: stops[b].line,
            stops: a - b,
            // 時刻表が揃えば乗車駅 dep・降車駅 arr の絶対時刻を持たせる（#65）。
            depTime: stops[b].dep,
            arrTime: stops[a].arr,
            // 乗車区間 b→a の停車駅座標を折れ線にする（shape 代替）。
            polyline: [for (var i = b; i <= a; i++) stops[i].coord],
          ),
          if (walk2.minutes > 0) walk2,
        ];
        result.add(
          RouteCandidate(from: base.from, to: base.to, segments: segments),
        );
      }
    }
    return result;
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

  /// [n] 個の停車駅から最大 [cap] 個を等間隔に抽出する（両端を含む）。
  List<int> _sampleIndices(int n, int cap) {
    if (n <= cap) return [for (var i = 0; i < n; i++) i];
    final out = <int>{};
    for (var k = 0; k < cap; k++) {
      out.add((k * (n - 1) / (cap - 1)).round());
    }
    return out.toList()..sort();
  }

  Future<Map<String, dynamic>> _fetchTransit(
    GeoPoint origin,
    GeoPoint goal,
    TimeValue departure,
  ) => _fetch('navitimeProxy', {
    'start': '${origin.lat},${origin.lng}',
    'goal': '${goal.lat},${goal.lng}',
    'start_time': _startTime(departure),
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
  }) async {
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
            // polyline が無ければ origin→dest を直線で結ぶ。
            polyline: shape.isNotEmpty ? shape : [origin, dest],
          ),
        ],
      );
    } on RouteException {
      return null;
    }
  }

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
        // 時刻表が揃えば乗車（始駅 dep）・降車（終駅 arr）の絶対時刻を持たせ、
        // タイムラインの乗車前・乗換待ちを反映する（#65）。
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
            depTime: sectionStops.isNotEmpty ? sectionStops.first.dep : null,
            arrTime: sectionStops.isNotEmpty ? sectionStops.last.arr : null,
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
          arr: DateTime.tryParse(e['from_time'] as String? ?? ''),
          dep: DateTime.tryParse(e['to_time'] as String? ?? ''),
          line: line,
          section: section,
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

  /// 出発時刻を ISO8601 へ整形。dateOffset（isNow→0）で日付を決定する。
  String _startTime(TimeValue t) {
    final dt = _departureDateTime(t);
    final y = dt.year.toString().padLeft(4, '0');
    final mo = dt.month.toString().padLeft(2, '0');
    final d = dt.day.toString().padLeft(2, '0');
    final h = dt.hour.toString().padLeft(2, '0');
    final mi = dt.minute.toString().padLeft(2, '0');
    return '$y-$mo-${d}T$h:$mi:00';
  }
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
  final int section;
}
