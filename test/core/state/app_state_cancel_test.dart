import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
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

/// 進捗を任意段階まで通知したあと completer が完了するまで待機するフェイク。
/// キャンセルが「進行中のリクエスト」を跨ぐ状況を再現するために使う。
class _GatedRouteService implements RouteService {
  Completer<void> completer = Completer<void>();

  /// false にすると completer を待たず即応答する（キャンセル後の再検索を同一
  /// Notifier で検証するために 2 回目だけゲートを外す）。
  bool gated = true;
  void Function(RoutePhase)? lastOnProgress;
  CancellationToken? lastCancellation;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
    CancellationToken? cancellation,
  }) async {
    lastOnProgress = onProgress;
    lastCancellation = cancellation;
    onProgress?.call(RoutePhase.routing);
    if (gated) await completer.future;
    return _plan;
  }
}

ProviderContainer _containerWith(RouteService service) {
  final container = ProviderContainer(
    overrides: [routeServiceProvider.overrideWithValue(service)],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  group('AppNotifier.cancelSearch', () {
    test('キャンセルすると即座にホームへ戻り routePhase がクリアされる', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      expect(container.read(appStateProvider).screen, Screen.loading);

      notifier.cancelSearch();
      final state = container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.routePhase, isNull);
      expect(state.routeErrorKind, isNull);

      // 後片付け（in-flight を完了させても state は home のまま）。
      service.completer.complete();
      await future;
      expect(container.read(appStateProvider).screen, Screen.home);
    });

    test('キャンセル後に plan が完了しても結果を反映しない', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      notifier.cancelSearch();
      service.completer.complete();
      await future;

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
    });

    test('キャンセル後は onProgress が来ても routePhase を書き換えない', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      notifier.cancelSearch();
      // in-flight の plan がまだ進捗通知を送ってくる状況を再現する。
      service.lastOnProgress?.call(RoutePhase.building);

      expect(container.read(appStateProvider).routePhase, isNull);

      service.completer.complete();
      await future;
    });

    test('同一 Notifier でキャンセル後に再検索すると result へ遷移する', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final first = notifier.startSearch();
      notifier.cancelSearch();
      service.completer.complete();
      await first;
      expect(container.read(appStateProvider).screen, Screen.home);

      // 世代が進んだ同一 Notifier で 2 回目を実行しても、その結果は正しく
      // 反映される（ガードが自世代の完了まで捨ててしまわないこと）。
      service.gated = false;
      await notifier.startSearch();
      expect(container.read(appStateProvider).screen, Screen.result);
      expect(container.read(appStateProvider).route, same(_plan));
    });

    test('startSearch は plan にキャンセルトークンを渡す', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      expect(service.lastCancellation, isNotNull);
      expect(service.lastCancellation!.isCanceled, isFalse);

      service.completer.complete();
      await future;
    });

    test('cancelSearch は進行中の plan に渡したトークンをキャンセルする', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      final token = service.lastCancellation!;
      expect(token.isCanceled, isFalse);

      notifier.cancelSearch();
      expect(token.isCanceled, isTrue);

      service.completer.complete();
      await future;
    });

    test('再検索ごとに新しいトークンを渡し前回をキャンセルする', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final first = notifier.startSearch();
      final firstToken = service.lastCancellation!;

      // キャンセルを挟まず即座に再検索しても、前回の通信は放置されず切られる。
      service.gated = false;
      await notifier.startSearch();
      final secondToken = service.lastCancellation!;

      expect(secondToken, isNot(same(firstToken)));
      expect(firstToken.isCanceled, isTrue);
      expect(secondToken.isCanceled, isFalse);

      service.completer.complete();
      await first;
    });

    test('provider dispose で進行中の plan のトークンをキャンセルする', () async {
      final service = _GatedRouteService();
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      final token = service.lastCancellation!;

      container.dispose();
      expect(token.isCanceled, isTrue);

      service.completer.complete();
      await expectLater(future, completes);
    });

    test('provider dispose 後に plan が完了しても例外を投げず state を書かない', () async {
      final service = _GatedRouteService();
      // 意図的に container を手動 dispose するため addTearDown は使わない。
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      container.dispose(); // _disposed = true
      service.completer.complete();

      // dispose 済み Notifier への state 書き込み（Riverpod 3.x では StateError）を
      // 避け、未捕捉例外なく完了する。
      await expectLater(future, completes);
    });
  });
}
