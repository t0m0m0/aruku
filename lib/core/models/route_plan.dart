import 'package:flutter/foundation.dart';

import 'geo_point.dart';

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
  final List<GeoPoint> polyline;
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
          GeoPoint(35.6909, 139.7069),
          GeoPoint(35.6850, 139.7050),
          GeoPoint(35.6790, 139.7035),
          GeoPoint(35.6703, 139.7027),
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
          GeoPoint(35.6703, 139.7027),
          GeoPoint(35.6640, 139.7020),
          GeoPoint(35.6580, 139.7016),
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
          GeoPoint(35.6580, 139.7016),
          GeoPoint(35.6585, 139.7025),
          GeoPoint(35.6592, 139.7031),
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
