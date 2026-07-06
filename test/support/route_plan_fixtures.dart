import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';

/// テスト専用のサンプル経路。旧 `RoutePlan.mock` の代替。
const sampleRoutePlan = RoutePlan(
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

/// 左折を1つだけ含む徒歩専用のL字経路（案内アイコン種別のテスト用）。
/// 東へ進み→左折して北上する形状（`nav_engine_test.dart` のL字ルートと同型）。
const leftTurnRoutePlan = RoutePlan(
  from: 'A地点',
  to: 'B地点',
  totalKm: 1.0,
  totalMin: 15,
  budgetMin: 30,
  kcal: 50,
  walkKm: 1.0,
  walkRatio: 1.0,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'A地点',
      toName: 'B地点',
      km: 1.0,
      minutes: 15,
      kcal: 50,
      polyline: [
        GeoPoint(35.0, 139.0),
        GeoPoint(35.0, 139.01),
        GeoPoint(35.01, 139.01),
      ],
    ),
  ],
  timelineNodes: [],
);
