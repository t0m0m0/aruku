import 'dart:async';
import 'dart:io';

import 'package:aruku/core/models/route_error.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

void main() {
  late AppLocalizations l10n;

  setUpAll(() async {
    l10n = await AppLocalizations.delegate.load(const Locale('ja'));
  });

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
        classifyRouteError(const RouteException('UNKNOWN')),
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
      // サービス最下層でタイムアウトを変換した RouteException('TIMEOUT') も
      // 通信系として扱う（#156）。
      expect(
        classifyRouteError(const RouteException('TIMEOUT')),
        RouteErrorKind.network,
      );
      expect(
        classifyRouteError(http.ClientException('reset')),
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
        final view = routeErrorView(l10n, kind);
        expect(view.kind, kind);
        expect(view.title, isNotEmpty);
        expect(view.description, isNotEmpty);
      }
    });

    test('noResults / noDestination は主導線が条件変更', () {
      expect(
        routeErrorView(l10n, RouteErrorKind.noResults).primaryRecovery,
        RouteRecovery.changeConditions,
      );
      expect(
        routeErrorView(l10n, RouteErrorKind.noDestination).primaryRecovery,
        RouteRecovery.changeConditions,
      );
    });

    test('network / noLocation / unknown は主導線が再試行', () {
      expect(
        routeErrorView(l10n, RouteErrorKind.network).primaryRecovery,
        RouteRecovery.retry,
      );
      expect(
        routeErrorView(l10n, RouteErrorKind.noLocation).primaryRecovery,
        RouteRecovery.retry,
      );
      expect(
        routeErrorView(l10n, RouteErrorKind.unknown).primaryRecovery,
        RouteRecovery.retry,
      );
    });
  });
}
