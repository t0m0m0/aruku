import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:flutter_test/flutter_test.dart';

const _plan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 1,
  totalMin: 1,
  budgetMin: 1,
  kcal: 1,
  walkKm: 1,
  walkRatio: 1,
  segments: [],
  timelineNodes: [],
);

/// plan() の完了タイミングを外から握れるエンジン。close 回数を観測する。
class _FakeEngine implements SearchEngine {
  _FakeEngine({this.gate, this.error});

  final Completer<void>? gate;
  final Object? error;
  int closed = 0;
  int planned = 0;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  }) async {
    planned++;
    if (gate != null) await gate!.future;
    if (error != null) throw error!;
    return _plan;
  }

  @override
  void close() => closed++;
}

Future<RoutePlan> _run(
  RouteService service, {
  CancellationToken? cancellation,
}) => service.plan(
  destination: 'B',
  destinationLatLng: const GeoPoint(35.0, 139.0),
  departure: const TimeValue(h: 9, m: 0),
  arrival: const TimeValue(h: 12, m: 0),
  origin: const GeoPoint(35.1, 139.1),
  cancellation: cancellation,
);

void main() {
  group('SearchScopedRouteService', () {
    test('plan ごとにエンジンを組み立てる', () async {
      final engines = <_FakeEngine>[];
      final service = SearchScopedRouteService((_) {
        final engine = _FakeEngine();
        engines.add(engine);
        return engine;
      });

      await _run(service);
      await _run(service);

      expect(engines, hasLength(2));
      expect(engines.every((e) => e.planned == 1), isTrue);
    });

    test('正常終了でもエンジンを閉じる', () async {
      final engine = _FakeEngine();
      final service = SearchScopedRouteService((_) => engine);

      await _run(service);
      expect(engine.closed, 1);
    });

    test('例外で終わってもエンジンを閉じる', () async {
      final engine = _FakeEngine(error: const RouteException('ZERO_RESULTS'));
      final service = SearchScopedRouteService((_) => engine);

      await expectLater(_run(service), throwsA(isA<RouteException>()));
      expect(engine.closed, 1);
    });

    test('キャンセルすると plan の完了を待たずにエンジンを閉じる', () async {
      final gate = Completer<void>();
      final engine = _FakeEngine(gate: gate);
      final service = SearchScopedRouteService((_) => engine);
      final cancellation = CancellationToken();

      final future = _run(service, cancellation: cancellation);
      await pumpEventQueue();
      expect(engine.closed, 0, reason: 'キャンセル前に閉じてはいけない');

      cancellation.cancel();
      expect(engine.closed, 1, reason: 'in-flight のうちに通信を切る');

      gate.complete();
      await expectLater(future, throwsA(isA<SearchCanceledException>()));
    });

    // close で in-flight のソケットが落ちると、その get は ClientException など
    // 任意の例外になる。呼び出し側がキャンセルを通信エラーと取り違えないよう、
    // キャンセル済みなら SearchCanceledException に揃える。
    test('キャンセル後に湧いた通信エラーは SearchCanceledException へ揃える', () async {
      final gate = Completer<void>();
      final engine = _FakeEngine(gate: gate, error: const RouteException('X'));
      final service = SearchScopedRouteService((_) => engine);
      final cancellation = CancellationToken();

      final future = _run(service, cancellation: cancellation);
      await pumpEventQueue();
      cancellation.cancel();
      gate.complete();

      await expectLater(future, throwsA(isA<SearchCanceledException>()));
    });

    test('キャンセルしなければ通信エラーはそのまま伝播する', () async {
      final engine = _FakeEngine(error: const RouteException('TIMEOUT'));
      final service = SearchScopedRouteService((_) => engine);

      await expectLater(
        _run(service, cancellation: CancellationToken()),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'TIMEOUT'),
        ),
      );
    });

    test('エンジンにキャンセルトークンを渡す', () async {
      CancellationToken? seen;
      final cancellation = CancellationToken();
      final service = SearchScopedRouteService((token) {
        seen = token;
        return _FakeEngine();
      });

      await _run(service, cancellation: cancellation);
      expect(seen, same(cancellation));
    });
  });
}
