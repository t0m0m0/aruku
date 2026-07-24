import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/navigation/leg_handoff.dart';
import 'package:flutter_test/flutter_test.dart';

// 蒲田→(徒歩)→新橋→(電車)→東京の2区間プラン。区間ごとの引き継ぎ先が
// 全行程の終点（東京）に固定されず、各区間の終点になることを確認するための固定経路。
const _kamata = GeoPoint(35.5614, 139.7161);
const _shimbashi = GeoPoint(35.6665, 139.7580);
const _tokyo = GeoPoint(35.6812, 139.7671);

RouteSegment _walkLegToShimbashi() => const RouteSegment(
  type: SegmentType.walk,
  fromName: '蒲田',
  toName: '新橋',
  minutes: 20,
  polyline: [_kamata, _shimbashi],
);

RouteSegment _trainLegToTokyo() => const RouteSegment(
  type: SegmentType.train,
  fromName: '新橋',
  toName: '東京',
  minutes: 3,
  line: 'JR山手線',
  polyline: [_shimbashi, _tokyo],
);

RouteSegment _walkLegNoPolyline() => const RouteSegment(
  type: SegmentType.walk,
  fromName: '蒲田',
  toName: '新橋駅',
  minutes: 20,
);

RoutePlan _routeOf(List<RouteSegment> segments, {String to = '東京'}) =>
    RoutePlan(
      from: '蒲田',
      to: to,
      totalKm: 5.0,
      totalMin: 23,
      budgetMin: 60,
      kcal: 100,
      walkKm: 2.0,
      walkRatio: 0.4,
      segments: segments,
      timelineNodes: const [],
    );

RoutePlan _twoLegRoute() =>
    _routeOf([_walkLegToShimbashi(), _trainLegToTokyo()]);

void main() {
  group('legEndPoint', () {
    test('polyline があれば最後の点を終点とする', () {
      expect(legEndPoint(_walkLegToShimbashi()), _shimbashi);
    });

    test('polyline が空なら null を返す', () {
      expect(legEndPoint(_walkLegNoPolyline()), isNull);
    });
  });

  group('legHandoffDestination', () {
    test('自区間の polyline 末尾を座標で返す', () {
      expect(legHandoffDestination(_twoLegRoute(), 0), '35.6665,139.758');
    });

    test('自区間の polyline が空なら次区間の polyline 先頭を座標で返す', () {
      // 区間は連結しており、次区間の始点は自区間の終点と同じ地点。名前より
      // 曖昧さが無いため、空 toName へ落ちる前にここで解決する。
      final route = _routeOf([_walkLegNoPolyline(), _trainLegToTokyo()]);

      expect(legHandoffDestination(route, 0), '35.6665,139.758');
    });

    test('自区間・次区間とも polyline が空なら toName を返す', () {
      final route = _routeOf([
        _walkLegNoPolyline(),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '新橋駅',
          toName: '東京',
          minutes: 3,
        ),
      ]);

      expect(legHandoffDestination(route, 0), '新橋駅');
    });

    test('座標も toName も無い中間区間は次区間の fromName を返す', () {
      final route = _routeOf([
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '蒲田',
          toName: '',
          minutes: 20,
        ),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '新橋駅',
          toName: '東京',
          minutes: 3,
        ),
      ]);

      expect(legHandoffDestination(route, 0), '新橋駅');
    });

    test('座標も toName も無い最終区間は RoutePlan.to を返す', () {
      // 最終区間の到着地は timelineNodes でも RoutePlan.to として描かれる
      // （route_plan_builder の到着ノード）。区間の toName ではなくそちらが正。
      final route = _routeOf([
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '新橋',
          toName: '',
          minutes: 8,
        ),
      ], to: '東京駅');

      expect(legHandoffDestination(route, 0), '東京駅');
    });

    test('座標も名前もどこにも無ければ null を返す', () {
      final route = _routeOf([
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '蒲田',
          toName: '',
          minutes: 20,
        ),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '',
          toName: '',
          minutes: 3,
        ),
      ], to: '');

      expect(legHandoffDestination(route, 0), isNull);
    });

    test('範囲外のインデックスは null を返す', () {
      final route = _twoLegRoute();
      expect(legHandoffDestination(route, -1), isNull);
      expect(legHandoffDestination(route, 2), isNull);
    });
  });

  group('buildLegHandoffUri', () {
    const origin = GeoPoint(35.5616, 139.7160);

    test(
      '徒歩区間は api=1・origin・座標destination・travelmode=walking・dir_action=navigate を含む',
      () {
        final uri = buildLegHandoffUri(
          route: _twoLegRoute(),
          index: 0,
          origin: origin,
        )!;

        expect(uri.toString(), startsWith('https://www.google.com/maps/dir/?'));
        expect(uri.queryParameters['api'], '1');
        expect(uri.queryParameters['origin'], '35.5616,139.716');
        expect(uri.queryParameters['destination'], '35.6665,139.758');
        expect(uri.queryParameters['travelmode'], 'walking');
        expect(uri.queryParameters['dir_action'], 'navigate');
      },
    );

    test('公共交通区間は travelmode=transit で dir_action を含まない', () {
      final uri = buildLegHandoffUri(
        route: _twoLegRoute(),
        index: 1,
        origin: origin,
      )!;

      expect(uri.queryParameters['travelmode'], 'transit');
      expect(uri.queryParameters.containsKey('dir_action'), isFalse);
      expect(uri.queryParameters['destination'], '35.6812,139.7671');
    });

    test('座標が全く無い区間では destination が toName の文字列になり日本語がエンコードされる', () {
      final route = _routeOf([
        _walkLegNoPolyline(),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '新橋駅',
          toName: '東京',
          minutes: 3,
        ),
      ]);
      final uri = buildLegHandoffUri(route: route, index: 0, origin: origin)!;

      expect(uri.queryParameters['destination'], '新橋駅');
      expect(uri.toString(), contains(Uri.encodeQueryComponent('新橋駅')));
    });

    test('index0（蒲田→新橋）の destination は全行程の終点(東京)ではなく区間終点(新橋)になる', () {
      final uri = buildLegHandoffUri(
        route: _twoLegRoute(),
        index: 0,
        origin: origin,
      )!;

      expect(uri.queryParameters['destination'], '35.6665,139.758');
      expect(uri.queryParameters['destination'], isNot('35.6812,139.7671'));
    });

    test('index1（新橋→東京）は transit で destination が東京になる', () {
      final uri = buildLegHandoffUri(
        route: _twoLegRoute(),
        index: 1,
        origin: origin,
      )!;

      expect(uri.queryParameters['travelmode'], 'transit');
      expect(uri.queryParameters['destination'], '35.6812,139.7671');
    });

    test('origin 省略時は origin クエリを含まない（Google Maps 側の現在地補完に委ねる）', () {
      final uri = buildLegHandoffUri(route: _twoLegRoute(), index: 0)!;

      expect(uri.queryParameters.containsKey('origin'), isFalse);
      expect(uri.queryParameters['destination'], '35.6665,139.758');
    });

    test('引き継ぎ先を特定できない区間は null を返す（空 destination を投げない）', () {
      final route = _routeOf([
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '蒲田',
          toName: '',
          minutes: 20,
        ),
        const RouteSegment(
          type: SegmentType.train,
          fromName: '',
          toName: '',
          minutes: 3,
        ),
      ], to: '');

      expect(
        buildLegHandoffUri(route: route, index: 0, origin: origin),
        isNull,
      );
    });

    test('範囲外のインデックスは null を返す', () {
      expect(buildLegHandoffUri(route: _twoLegRoute(), index: 2), isNull);
    });
  });

  group('isLegArrived', () {
    test('閾値内なら true を返す', () {
      // 新橋からおよそ5m北（閾値8m以内）
      const nearby = GeoPoint(35.66655, 139.7580);
      expect(isLegArrived(leg: _walkLegToShimbashi(), current: nearby), isTrue);
    });

    test('閾値外なら false を返す', () {
      // 新橋からおよそ100km離れた点
      const farAway = GeoPoint(36.5, 139.7580);
      expect(
        isLegArrived(leg: _walkLegToShimbashi(), current: farAway),
        isFalse,
      );
    });

    test('polyline が空で終点座標が不明な区間は常に false（曖昧な区間を自動完了させない）', () {
      expect(
        isLegArrived(leg: _walkLegNoPolyline(), current: _shimbashi),
        isFalse,
      );
    });

    test('閾値は引数で差し替えられる', () {
      // 新橋からおよそ50m北。既定閾値(8m)では false だが、緩めた閾値では true
      const fiftyMetersAway = GeoPoint(35.6670, 139.7580);
      expect(
        isLegArrived(leg: _walkLegToShimbashi(), current: fiftyMetersAway),
        isFalse,
      );
      expect(
        isLegArrived(
          leg: _walkLegToShimbashi(),
          current: fiftyMetersAway,
          thresholdKm: 0.1,
        ),
        isTrue,
      );
    });
  });

  group('legAt', () {
    test('範囲内のインデックスで区間を返す', () {
      final route = _twoLegRoute();
      expect(legAt(route, 0), route.segments[0]);
      expect(legAt(route, 1), route.segments[1]);
    });

    test('範囲外のインデックスは null を返す', () {
      final route = _twoLegRoute();
      expect(legAt(route, -1), isNull);
      expect(legAt(route, 2), isNull);
    });
  });
}
