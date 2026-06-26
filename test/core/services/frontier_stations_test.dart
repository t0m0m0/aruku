import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart';
import 'package:flutter_test/flutter_test.dart';

/// frontierStations: 直線距離で乗降候補駅を片側 K に絞る純粋関数（measure-first の肝）。
///
/// 乗車側は origin→駅、降車側は 駅→goal の直線徒歩分を見て、その直線徒歩が予算内の駅
/// だけを feasible とし（直線は道なり徒歩の下限なので、直線が予算超過なら確実に予算外）、
/// feasible が maxPerSide を超えれば均等間隔で間引く（両端＋中間を残し b<a ペアを保つ）。
/// 返すインデックスは駅配列の昇順（下流のペアリング用）。
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

    test('maxPerSide 超は均等間引きで両端を残す', () {
      final r = frontierStations(monotonic, origin, goal, 1000, maxPerSide: 2);
      // 徒歩分降順 top-K だと乗車側=[2,3]・降車側=[0,1] に割れて b<a ペアが作れない。
      // 均等間引きは両端を残す → 両側とも [0,3]（b=0<a=3 のペアが作れる）。
      expect(r.boarding, [0, 3]);
      expect(r.alighting, [0, 3]);
    });

    test('maxPerSide 超の長大路線でも中間駅を残し b<a の乗降ペアを保つ', () {
      // origin 西・goal 東、12駅が等間隔。予算大で全12駅が両側 feasible。
      // 片側 top-K（徒歩降順）だと乗車側=東寄り・降車側=西寄りに割れて b<a が作れないが、
      // 均等間引きなら両端＋中間が残り b<a ペアが存在する。
      final stops = [
        for (var i = 1; i <= 12; i++) GeoPoint(35.0, 139.0 + i * 0.005),
      ];
      const farOrigin = GeoPoint(35.0, 139.0);
      const farGoal = GeoPoint(35.0, 139.07);
      final r = frontierStations(
        stops,
        farOrigin,
        farGoal,
        1000,
        maxPerSide: 4,
      );
      expect(r.boarding, hasLength(4));
      expect(r.alighting, hasLength(4));
      // 両端（最遠アクセス・最遠エグレスの候補）を取りこぼさない。
      expect(r.boarding.first, 0);
      expect(r.boarding.last, 11);
      // 中間駅が残るため b<a の乗降ペアが少なくとも1組存在する。
      final hasPair = r.boarding.any((b) => r.alighting.any((a) => b < a));
      expect(hasPair, isTrue);
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
