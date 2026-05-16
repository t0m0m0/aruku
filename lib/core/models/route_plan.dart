import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

enum SegmentType { walk, train }

@immutable
class RouteSegment {
  const RouteSegment({
    required this.type,
    required this.fromName,
    required this.toName,
    required this.minutes,
    this.km,
    this.kcal,
    this.line,
    this.fare,
    this.stops,
    this.polyline = const [],
  });

  final SegmentType type;
  final String fromName;
  final String toName;
  final int minutes;
  final double? km;
  final int? kcal;
  final String? line;
  final int? fare;
  final int? stops;

  /// このセグメントの経路座標列。地図上のポリライン描画に使う。
  final List<LatLng> polyline;
}

@immutable
class TimelineNode {
  const TimelineNode({
    required this.time,
    required this.place,
    required this.sub,
  });

  final String time;
  final String place;
  final String sub;
}

@immutable
class RoutePlan {
  const RoutePlan({
    required this.from,
    required this.to,
    required this.totalKm,
    required this.totalMin,
    required this.budgetMin,
    required this.kcal,
    required this.walkKm,
    required this.walkRatio,
    required this.segments,
    required this.timelineNodes,
  });

  final String from;
  final String to;
  final double totalKm;
  final int totalMin;
  final int budgetMin;
  final int kcal;
  final double walkKm;
  final double walkRatio;
  final List<RouteSegment> segments;
  final List<TimelineNode> timelineNodes;

  static const mock = RoutePlan(
    from: '新宿三丁目',
    to: '渋谷ヒカリエ',
    totalKm: 6.2,
    totalMin: 78,
    budgetMin: 90,
    kcal: 291,
    walkKm: 5.1,
    walkRatio: 0.82,
    segments: [
      RouteSegment(
        type: SegmentType.walk,
        fromName: '新宿三丁目',
        toName: '原宿駅',
        km: 2.4,
        minutes: 30,
        kcal: 138,
        polyline: [
          LatLng(35.6909, 139.7069),
          LatLng(35.6850, 139.7050),
          LatLng(35.6790, 139.7035),
          LatLng(35.6703, 139.7027),
        ],
      ),
      RouteSegment(
        type: SegmentType.train,
        fromName: '原宿',
        toName: '渋谷',
        minutes: 3,
        line: 'JR山手線',
        fare: 150,
        stops: 1,
        polyline: [
          LatLng(35.6703, 139.7027),
          LatLng(35.6640, 139.7020),
          LatLng(35.6580, 139.7016),
        ],
      ),
      RouteSegment(
        type: SegmentType.walk,
        fromName: '渋谷駅',
        toName: '渋谷ヒカリエ',
        km: 2.7,
        minutes: 35,
        kcal: 153,
        polyline: [
          LatLng(35.6580, 139.7016),
          LatLng(35.6585, 139.7025),
          LatLng(35.6592, 139.7031),
        ],
      ),
    ],
    timelineNodes: [
      TimelineNode(time: '9:32', place: '新宿三丁目', sub: '出発'),
      TimelineNode(time: '10:02', place: '原宿駅 表参道口', sub: 'JR山手線 内回り 渋谷方面'),
      TimelineNode(time: '10:05', place: '渋谷駅 ハチ公口', sub: '徒歩へ'),
      TimelineNode(time: '10:40', place: '渋谷ヒカリエ', sub: '到着 · 制限内 ✓'),
    ],
  );
}

/// 徒歩ルート色（moss500）。
const _walkColor = Color(0xFF4F9527);

/// 電車ルート色（train）。
const _trainColor = Color(0xFF3E6792);

/// [RoutePlan] を実地図用のオーバーレイ（ポリライン・マーカー・バウンズ）へ変換する。
extension RouteMapOverlays on RoutePlan {
  /// セグメントごとに 1 本のポリライン。
  /// 徒歩＝moss の破線、電車＝train の実線。座標の無いセグメントは除外。
  Set<Polyline> toPolylines() {
    final result = <Polyline>{};
    for (var i = 0; i < segments.length; i++) {
      final seg = segments[i];
      if (seg.polyline.isEmpty) continue;
      final isWalk = seg.type == SegmentType.walk;
      result.add(
        Polyline(
          polylineId: PolylineId('seg-$i'),
          points: seg.polyline,
          color: isWalk ? _walkColor : _trainColor,
          width: isWalk ? 5 : 6,
          startCap: Cap.roundCap,
          endCap: Cap.roundCap,
          jointType: JointType.round,
          patterns: isWalk
              ? [PatternItem.dash(20), PatternItem.gap(12)]
              : const [],
        ),
      );
    }
    return result;
  }

  List<LatLng> get _allPoints => [for (final s in segments) ...s.polyline];

  /// 出発・到着マーカー。座標が無ければ空集合。
  Set<Marker> toMarkers() {
    final points = _allPoints;
    if (points.isEmpty) return {};
    return {
      Marker(
        markerId: const MarkerId('start'),
        position: points.first,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
      ),
      Marker(
        markerId: const MarkerId('end'),
        position: points.last,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
      ),
    };
  }

  /// ルート全体を囲むバウンズ。座標が無ければ null。
  LatLngBounds? toBounds() {
    final points = _allPoints;
    if (points.isEmpty) return null;
    var minLat = points.first.latitude;
    var maxLat = points.first.latitude;
    var minLng = points.first.longitude;
    var maxLng = points.first.longitude;
    for (final p in points) {
      minLat = p.latitude < minLat ? p.latitude : minLat;
      maxLat = p.latitude > maxLat ? p.latitude : maxLat;
      minLng = p.longitude < minLng ? p.longitude : minLng;
      maxLng = p.longitude > maxLng ? p.longitude : maxLng;
    }
    return LatLngBounds(
      southwest: LatLng(minLat, minLng),
      northeast: LatLng(maxLat, maxLng),
    );
  }
}
