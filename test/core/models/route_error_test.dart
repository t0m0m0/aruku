import 'dart:async';
import 'dart:io';

import 'package:aruku/core/models/route_error.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('classifyRouteError', () {
    test('NO_ORIGIN は noLocation', () {
      expect(
        classifyRouteError(const RouteException('NO_ORIGIN')),
        RouteErrorKind.noLocation,
      );
    });

    test('NO_DESTINATION は noDestination', () {
      expect(
        classifyRouteError(const RouteException('NO_DESTINATION')),
        RouteErrorKind.noDestination,
      );
    });

    test('ZERO_RESULTS / NOT_FOUND は noResults', () {
      expect(
        classifyRouteError(const RouteException('ZERO_RESULTS')),
        RouteErrorKind.noResults,
      );
      expect(
        classifyRouteError(const RouteException('NOT_FOUND')),
        RouteErrorKind.noResults,
      );
    });

    test('HTTP エラー / 通信系例外は network', () {
      expect(
        classifyRouteError(const RouteException('HTTP 500')),
        RouteErrorKind.network,
      );
      expect(
        classifyRouteError(const RouteException('UNKNOWN_ERROR')),
        RouteErrorKind.network,
      );
      expect(
        classifyRouteError(const SocketException('failed')),
        RouteErrorKind.network,
      );
      expect(
        classifyRouteError(TimeoutException('slow')),
        RouteErrorKind.network,
      );
    });

    test('NO_PROXY や未知の API status は unknown', () {
      expect(
        classifyRouteError(const RouteException('NO_PROXY')),
        RouteErrorKind.unknown,
      );
      expect(
        classifyRouteError(const RouteException('REQUEST_DENIED')),
        RouteErrorKind.unknown,
      );
      expect(classifyRouteError(Exception('boom')), RouteErrorKind.unknown);
    });
  });

  group('routeErrorView', () {
    test('各種別にタイトル・説明・主導線が定義される', () {
      for (final kind in RouteErrorKind.values) {
        final view = routeErrorView(kind);
        expect(view.kind, kind);
        expect(view.title, isNotEmpty);
        expect(view.description, isNotEmpty);
      }
    });

    test('noResults / noDestination は主導線が条件変更', () {
      expect(
        routeErrorView(RouteErrorKind.noResults).primaryRecovery,
        RouteRecovery.changeConditions,
      );
      expect(
        routeErrorView(RouteErrorKind.noDestination).primaryRecovery,
        RouteRecovery.changeConditions,
      );
    });

    test('network / noLocation / unknown は主導線が再試行', () {
      expect(
        routeErrorView(RouteErrorKind.network).primaryRecovery,
        RouteRecovery.retry,
      );
      expect(
        routeErrorView(RouteErrorKind.noLocation).primaryRecovery,
        RouteRecovery.retry,
      );
      expect(
        routeErrorView(RouteErrorKind.unknown).primaryRecovery,
        RouteRecovery.retry,
      );
    });
  });
}
