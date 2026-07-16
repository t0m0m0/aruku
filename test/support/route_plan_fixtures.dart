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

/// [sampleRoutePlan] と同じ FROM/TO を持つ代替案1件目。乗換0・電車区間の
/// arrTime を持つため、代替案カードの到着表示が実測時刻から組み立てられる
/// ケースを固定する。
final sampleAlternativeArrTime = RoutePlan(
  from: '新宿三丁目',
  to: '渋谷ヒカリエ',
  totalKm: 4.5,
  totalMin: 68,
  budgetMin: 90,
  kcal: 210,
  walkKm: 3.5,
  walkRatio: 0.75,
  segments: [
    const RouteSegment(
      type: SegmentType.walk,
      fromName: '新宿三丁目',
      toName: '代々木駅',
      km: 1.5,
      minutes: 18,
      kcal: 90,
    ),
    const RouteSegment(
      type: SegmentType.train,
      fromName: '代々木',
      toName: '渋谷',
      minutes: 12,
      line: 'JR山手線',
    ),
    RouteSegment(
      type: SegmentType.walk,
      fromName: '渋谷駅',
      toName: '渋谷ヒカリエ',
      km: 2.0,
      minutes: 38,
      kcal: 120,
      // 通常は徒歩区間に arrTime は付かないが、最終区間の arrTime を優先する
      // 分岐（timelineNodes より前）を固定するため、テストでは明示的に与える。
      arrTime: DateTime(2026, 7, 15, 10, 40),
    ),
  ],
  timelineNodes: const [
    TimelineNode(time: '9:32', place: '新宿三丁目', sub: '出発'),
    TimelineNode(time: '10:41', place: '渋谷ヒカリエ', sub: '到着'),
  ],
);

/// 代替案2件目。乗換1・徒歩は短めで到着が早い（[sampleAlternativeArrTime] と
/// 数値が異なることをカードの切替テストで見分けるため）。
const sampleAlternativeTimelineNode = RoutePlan(
  from: '新宿三丁目',
  to: '渋谷ヒカリエ',
  totalKm: 3.0,
  totalMin: 55,
  budgetMin: 90,
  kcal: 150,
  walkKm: 2.0,
  walkRatio: 0.6,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: '新宿三丁目',
      toName: '新宿駅',
      km: 0.8,
      minutes: 10,
      kcal: 48,
    ),
    RouteSegment(
      type: SegmentType.train,
      fromName: '新宿',
      toName: '代々木',
      minutes: 4,
      line: 'JR中央線',
    ),
    RouteSegment(
      type: SegmentType.train,
      fromName: '代々木',
      toName: '渋谷',
      minutes: 12,
      line: 'JR山手線',
    ),
    RouteSegment(
      type: SegmentType.walk,
      fromName: '渋谷駅',
      toName: '渋谷ヒカリエ',
      km: 1.2,
      minutes: 22,
      kcal: 66,
    ),
  ],
  timelineNodes: [
    TimelineNode(time: '9:32', place: '新宿三丁目', sub: '出発'),
    TimelineNode(time: '10:27', place: '渋谷ヒカリエ', sub: '到着'),
  ],
);

/// [sampleRoutePlan] に代替案2件（[sampleAlternativeArrTime] /
/// [sampleAlternativeTimelineNode]）を積んだ版。結果画面の候補セクション表示を
/// 固定するテストで使う。
final sampleRoutePlanWithAlternatives = RoutePlan(
  from: sampleRoutePlan.from,
  to: sampleRoutePlan.to,
  totalKm: sampleRoutePlan.totalKm,
  totalMin: sampleRoutePlan.totalMin,
  budgetMin: sampleRoutePlan.budgetMin,
  kcal: sampleRoutePlan.kcal,
  walkKm: sampleRoutePlan.walkKm,
  walkRatio: sampleRoutePlan.walkRatio,
  segments: sampleRoutePlan.segments,
  timelineNodes: sampleRoutePlan.timelineNodes,
  alternatives: [sampleAlternativeArrTime, sampleAlternativeTimelineNode],
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
