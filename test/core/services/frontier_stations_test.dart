import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/navitime_route_service.dart';
import 'package:flutter_test/flutter_test.dart';

/// frontierStations: 直線距離で乗降候補駅を上位 K に絞る純粋関数（measure-first の肝）。
///
/// 乗車側は origin→駅、降車側は 駅→goal の直線徒歩分を見て、その直線徒歩が予算内の駅
/// だけを feasible とし（直線は道なり徒歩の下限なので、直線が予算超過なら確実に予算外）、
/// 徒歩分の大きい順に片側 maxPerSide まで採る。返すインデックスは駅配列の昇順
/// （下流のペアリング用）。
void main() {
  group('frontierStations', () {
    // 経度線上に等間隔で並ぶ駅。origin は西端、goal は東端のさらに東。
    // → origin への距離は s0<s1<s2<s3（単調増加）、goal への距離は逆順（単調減少）。
    const origin = GeoPoint(35.0, 139.00);
    const goal = GeoPoint(35.0, 139.05);
    const monotonic = <GeoPoint>[
      GeoPoint(35.0, 139.01), // s0: origin に最も近い / goal から最も遠い
      GeoPoint(35.0, 139.02), // s1
      GeoPoint(35.0, 139.03), // s2
      GeoPoint(35.0, 139.04), // s3: origin から最も遠い / goal に最も近い
    ];

    test('予算が十分大きければ全駅を両側の候補にする', () {
      final r = frontierStations(monotonic, origin, goal, 1000);
      expect(r.boarding, [0, 1, 2, 3]);
      expect(r.alighting, [0, 1, 2, 3]);
    });

    test('maxPerSide で片側を上限まで絞り、徒歩分の大きい駅を優先する', () {
      final r = frontierStations(monotonic, origin, goal, 1000, maxPerSide: 2);
      // 乗車側は origin から遠い順 → s3,s2（昇順で [2,3]）。
      expect(r.boarding, [2, 3]);
      // 降車側は goal から遠い順 → s0,s1（昇順で [0,1]）。
      expect(r.alighting, [0, 1]);
    });

    test('直線徒歩が予算を超える駅は feasible から外す（左右非対称）', () {
      // s0 は origin の至近・goal の最遠、s2 は goal の至近・origin の最遠。
      const origin2 = GeoPoint(35.0, 139.000);
      const goal2 = GeoPoint(35.0, 139.300);
      const stops = <GeoPoint>[
        GeoPoint(35.0, 139.002), // s0: origin 至近, goal 最遠
        GeoPoint(35.0, 139.150), // s1: 両側とも遠い
        GeoPoint(35.0, 139.298), // s2: origin 最遠, goal 至近
        GeoPoint(35.1, 139.150), // s3: 両側とも遠い
      ];
      final r = frontierStations(stops, origin2, goal2, 30);
      // origin から徒歩予算内なのは s0 だけ、goal へ徒歩予算内なのは s2 だけ。
      expect(r.boarding, [0]);
      expect(r.alighting, [2]);
    });

    test('空の駅配列なら両側とも空', () {
      final r = frontierStations(const [], origin, goal, 100);
      expect(r.boarding, isEmpty);
      expect(r.alighting, isEmpty);
    });
  });
}
