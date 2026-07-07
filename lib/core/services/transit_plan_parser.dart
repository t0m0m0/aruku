import 'package:flutter/foundation.dart';

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import 'hybrid_route_selector.dart' show haversineKm;
import 'rail_line_names.dart';
import 'route_plan_builder.dart' show kcalPerKm;

/// Transit API `/guidance/plan` の 1 option を解析した door-to-door 経路（#137）。
///
/// NAVITIME 版の `_TransitParse` 相当だが、データ源非依存の選定ロジック
/// （`selectBestRoute` ほか）へ渡すための `RouteSegment` 列に加え、乗車駅探索の
/// サンプリング母集合になる transit leg ごとの [TransitCorridor] を持つ。
@immutable
class TransitOption {
  const TransitOption({
    required this.from,
    required this.to,
    required this.segments,
    required this.corridors,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;

  /// 電車区間ごとのコリドー座標（origin→goal 方向に順序付き）。
  final List<TransitCorridor> corridors;
}

/// 電車区間（transit leg）の経路コリドー。`geometrySource` により意味が異なる：
/// `stopOrder` は停車駅座標、`gtfsShape` は線路追従の頂点（停車駅とは無関係）。
/// いずれも乗車駅探索ではコリドー上の候補座標として間引きサンプリングして使う
/// （docs/notes/transit-api-migration.md §2.5）。
@immutable
class TransitCorridor {
  const TransitCorridor({
    required this.legIndex,
    required this.geometrySource,
    required this.coords,
  });

  /// この区間が経路中で何本目の電車区間か（0 始まり）。
  final int legIndex;
  final String geometrySource;
  final List<GeoPoint> coords;
}

/// `/guidance/plan` レスポンス全体を [TransitOption] 群へ解析する。
/// `options` が無い・配列でないときは空リスト。
List<TransitOption> parseGuidancePlan(Map<String, dynamic> body) {
  final options = body['options'];
  if (options is! List) return const [];

  final date = body['date'] as String?;
  final fromName = _nameOf(body['from']) ?? '出発地';
  final toName = _nameOf(body['to']) ?? '目的地';

  final out = <TransitOption>[];
  for (final o in options) {
    if (o is! Map<String, dynamic>) continue;
    final parsed = _parseOption(o, date, fromName, toName);
    if (parsed != null) out.add(parsed);
  }
  return out;
}

/// 1 option を解析する。`journey.legs`（時刻・路線）を本体に、`map.segments`
/// （access/egress を含む全ジオメトリ）から polyline を充てる。transit leg と
/// map の transit セグメントは同数・同順で対応する（実機検証済み）。
TransitOption? _parseOption(
  Map<String, dynamic> opt,
  String? date,
  String fromName,
  String toName,
) {
  final journey = opt['journey'];
  if (journey is! Map) return null;
  final legs =
      (journey['legs'] as List?)?.whereType<Map>().toList() ?? const [];

  final map = opt['map'];
  final mapSegs =
      ((map is Map ? map['segments'] : null) as List?)
          ?.whereType<Map>()
          .toList() ??
      const <Map>[];

  final transitMapSegs = [
    for (final s in mapSegs)
      if (s['kind'] == 'transit') s,
  ];
  final firstTransitIdx = mapSegs.indexWhere((s) => s['kind'] == 'transit');
  final lastTransitIdx = mapSegs.lastIndexWhere((s) => s['kind'] == 'transit');

  // 電車を含まない＝全徒歩 option。単一の徒歩区間へ畳む。
  if (firstTransitIdx < 0) {
    final secs = (journey['durationSecs'] as num?)?.toInt() ?? 0;
    final coords = [for (final s in mapSegs) ..._coords(s['polyline'])];
    return TransitOption(
      from: fromName,
      to: toName,
      segments: [_walkSeg(fromName, toName, secs, coords)],
      corridors: const [],
    );
  }

  final transitLegs = [
    for (final l in legs)
      if (l['kind'] == 'transit') l,
  ];
  final firstBoardName = transitLegs.isNotEmpty
      ? (_nameOf(transitLegs.first['from']) ?? fromName)
      : fromName;
  final lastAlightName = transitLegs.isNotEmpty
      ? (_nameOf(transitLegs.last['to']) ?? toName)
      : toName;

  final segments = <RouteSegment>[];
  final corridors = <TransitCorridor>[];

  // access walk: 最初の電車より前の徒歩セグメント群（journey.accessWalkSecs を所要に）。
  final accessSecs = (journey['accessWalkSecs'] as num?)?.toInt() ?? 0;
  if (accessSecs > 0) {
    final coords = _walkCoordsBetween(mapSegs, 0, firstTransitIdx);
    segments.add(_walkSeg(fromName, firstBoardName, accessSecs, coords));
  }

  var ti = 0;
  for (final leg in legs) {
    switch (leg['kind']) {
      case 'transit':
        final seg = ti < transitMapSegs.length ? transitMapSegs[ti] : null;
        final coords = seg != null
            ? _coords(seg['polyline'])
            : const <GeoPoint>[];
        final geom = (seg?['geometrySource'] as String?) ?? '';
        final depSec = (leg['departureSecs'] as num?)?.toInt();
        final arrSec = (leg['arrivalSecs'] as num?)?.toInt();
        segments.add(
          RouteSegment(
            type: SegmentType.train,
            fromName: _nameOf(leg['from']) ?? '',
            toName: _nameOf(leg['to']) ?? '',
            minutes: _diffMin(depSec, arrSec),
            km: _polylineKm(coords),
            line: railLineLabel(leg['routeName'] as String?),
            depTime: transitSecsToJst(date, depSec),
            arrTime: transitSecsToJst(date, arrSec),
            polyline: coords,
          ),
        );
        corridors.add(
          TransitCorridor(legIndex: ti, geometrySource: geom, coords: coords),
        );
        ti++;
      case 'walk':
        // 乗換徒歩。所要は leg の arr-dep（次電車までの待ちは含めない＝待ちは
        // 次電車の depTime で route_plan_builder が吸収する #65）。
        final depSec = (leg['departureSecs'] as num?)?.toInt();
        final arrSec = (leg['arrivalSecs'] as num?)?.toInt();
        final secs = (depSec != null && arrSec != null) ? arrSec - depSec : 0;
        final coords = _transferWalkCoords(mapSegs, leg);
        final seg = _walkSeg(
          _nameOf(leg['from']) ?? '',
          _nameOf(leg['to']) ?? '',
          secs,
          coords,
        );
        // 同駅乗換など距離・所要ともに実質ゼロの徒歩レッグはノイズなので生成しない（#225）。
        if (!seg.isZeroWalk) segments.add(seg);
    }
  }

  // egress walk: 最後の電車より後の徒歩セグメント群（journey.egressWalkSecs を所要に）。
  final egressSecs = (journey['egressWalkSecs'] as num?)?.toInt() ?? 0;
  if (egressSecs > 0) {
    final coords = _walkCoordsBetween(
      mapSegs,
      lastTransitIdx + 1,
      mapSegs.length,
    );
    segments.add(_walkSeg(lastAlightName, toName, egressSecs, coords));
  }

  if (segments.isEmpty) return null;
  return TransitOption(
    from: fromName,
    to: toName,
    segments: segments,
    corridors: corridors,
  );
}

/// 徒歩区間を作る。所要は秒→分丸め、距離は polyline 折れ線長、kcal は距離換算。
RouteSegment _walkSeg(
  String fromName,
  String toName,
  int secs,
  List<GeoPoint> coords,
) {
  final km = _polylineKm(coords);
  return RouteSegment(
    type: SegmentType.walk,
    fromName: fromName,
    toName: toName,
    minutes: (secs / 60).round(),
    km: km,
    kcal: (km * kcalPerKm).round(),
    polyline: coords,
  );
}

/// [start, end) の範囲にある徒歩セグメントの polyline 座標を連結する。
List<GeoPoint> _walkCoordsBetween(List<Map> mapSegs, int start, int end) => [
  for (var i = start; i < end && i < mapSegs.length; i++)
    if (mapSegs[i]['kind'] == 'walk') ..._coords(mapSegs[i]['polyline']),
];

/// 乗換徒歩 [leg] に対応する map の徒歩セグメント polyline を、両端の駅 id
/// （`fromPointId`/`toPointId` == `leg.from.id`/`leg.to.id`）で突き合わせて返す。
/// 一致が無ければ空（端点欠落は呼び出し側で許容）。
List<GeoPoint> _transferWalkCoords(List<Map> mapSegs, Map leg) {
  final fromId = (leg['from'] as Map?)?['id'];
  final toId = (leg['to'] as Map?)?['id'];
  for (final s in mapSegs) {
    if (s['kind'] != 'walk') continue;
    if (s['fromPointId'] == fromId && s['toPointId'] == toId) {
      return _coords(s['polyline']);
    }
  }
  return const [];
}

/// polyline（`{lat, lon}` または point オブジェクト `{lat, lon, id, ...}` の配列）を
/// 座標列へ変換する。lat/lon を欠く要素は無視する。
List<GeoPoint> _coords(Object? polyline) {
  if (polyline is! List) return const [];
  final out = <GeoPoint>[];
  for (final p in polyline) {
    if (p is! Map) continue;
    final lat = (p['lat'] as num?)?.toDouble();
    final lon = ((p['lon'] as num?) ?? (p['lng'] as num?))?.toDouble();
    if (lat != null && lon != null) out.add(GeoPoint(lat, lon));
  }
  return out;
}

/// 座標列の折れ線長（km）。2 点未満は 0。
double _polylineKm(List<GeoPoint> coords) {
  var km = 0.0;
  for (var i = 0; i + 1 < coords.length; i++) {
    km += haversineKm(coords[i], coords[i + 1]);
  }
  return km;
}

/// 発車秒・到着秒（サービス日 0 時起算）の差を分へ丸める。どちらか欠落なら 0。
int _diffMin(int? depSec, int? arrSec) =>
    (depSec != null && arrSec != null) ? ((arrSec - depSec) / 60).round() : 0;

/// `{id, name}` 形式から name を取り出す。私鉄駅名に付くローマ字サフィックスは落とす。
String? _nameOf(Object? o) {
  if (o is! Map) return null;
  final name = o['name'] as String?;
  return name == null ? null : stripStationRomaji(name);
}

/// 私鉄フィードの駅名は `下北沢 Shimo-kitazawa` のように和名のあとへ空白区切りで
/// ローマ字（マクロン・ハイフンを含む）が付く。利用者表示には不要なので、和名を残して
/// 末尾のローマ字を落とす。JR の和名（ローマ字なし）はそのまま返す。
@visibleForTesting
String stripStationRomaji(String name) =>
    name.replaceFirst(_romajiSuffix, '').trim();

/// 末尾の「空白＋ローマ字（ラテン文字・マクロン・ハイフン・空白）」にマッチする。
final RegExp _romajiSuffix = RegExp(r"[\s　]+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\s\-’']*$");

/// サービス日 [date]（`YYYYMMDD`）の 0 時に [secs] 秒を足した naive JST DateTime を
/// 返す（#137・#121）。`departureSecs`/`arrivalSecs` はサービス日 0 時起算の秒で、
/// 0 時跨ぎ便では 86400 を超え得る——`Duration` 加算で翌日へ自然に繰り上がる。
///
/// NAVITIME 版の `parseNavitimeJst` と同じく、出発アンカー（ユーザー選択の壁時計値を
/// 持つ naive DateTime）との `difference` が端末 TZ に依存しないよう naive（isUtc=false）
/// で返す。[date] が 8 桁でない・[secs] が null・解析不能なら null。
@visibleForTesting
DateTime? transitSecsToJst(String? date, int? secs) {
  if (date == null || date.length != 8 || secs == null) return null;
  final y = int.tryParse(date.substring(0, 4));
  final mo = int.tryParse(date.substring(4, 6));
  final d = int.tryParse(date.substring(6, 8));
  if (y == null || mo == null || d == null) return null;
  return DateTime(y, mo, d).add(Duration(seconds: secs));
}
