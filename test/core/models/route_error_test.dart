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
        classifyRouteError(http.ClientException('reset')),
        RouteErrorKind.network,
      );
    });

    test('タイムアウトは network と別種別にする (#300)', () {
      // 上流 Transit API の遅延（正常9〜11秒・裾30秒超）は「通信断」ではない。
      // network に丸めると「通信状況を確認して再試行」と案内してしまい、電波が
      // 正常なユーザーを的外れな導線へ送る。#300 の切り分けでは画面表示から
      // App Check 拒否・レート制限・上流遅延を区別できないこと自体が障害になった。
      expect(
        classifyRouteError(const RouteException('TIMEOUT')),
        RouteErrorKind.timeout,
      );
      expect(
        classifyRouteError(TimeoutException('slow')),
        RouteErrorKind.timeout,
      );
    });

    test('タイムアウト以外の通信系は network のまま (#300)', () {
      // 分離の副作用で通信断まで timeout へ寄せていないことの反証。
      expect(
        classifyRouteError(const SocketException('failed')),
        RouteErrorKind.network,
      );
      expect(
        classifyRouteError(http.ClientException('reset')),
        RouteErrorKind.network,
      );
      expect(
        classifyRouteError(const RouteException('HTTP 500')),
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

    test('タイムアウトは network と別の文言で、主導線は再試行 (#300)', () {
      final timeout = routeErrorView(l10n, RouteErrorKind.timeout);
      final network = routeErrorView(l10n, RouteErrorKind.network);

      expect(timeout.title, isNot(network.title));
      expect(timeout.description, isNot(network.description));
      // 上流が遅いだけで経路自体は存在し得るので、導線は条件変更でなく再試行。
      expect(timeout.primaryRecovery, RouteRecovery.retry);
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
