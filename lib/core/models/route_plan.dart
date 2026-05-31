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
    this.depTime,
    this.arrTime,
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

  /// この区間の出発（電車は乗車）絶対時刻。時刻表データが揃う電車区間でのみ設定し、
  /// 徒歩・時刻欠落の概算区間では null（タイムラインは累積所要分にフォールバック）。
  final DateTime? depTime;

  /// この区間の到着（電車は降車）絶対時刻。設定条件は [depTime] と同じ。
  final DateTime? arrTime;
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
}
