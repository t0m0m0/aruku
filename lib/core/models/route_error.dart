import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../../l10n/app_localizations.dart';
import '../services/route_service.dart';

/// ルート計算失敗の種別。UI の文言と復帰導線の出し分けに使う。
enum RouteErrorKind { network, noResults, noLocation, noDestination, unknown }

/// エラー画面で主に提示する復帰アクション。
enum RouteRecovery { retry, changeConditions }

class RouteErrorView {
  const RouteErrorView({
    required this.kind,
    required this.title,
    required this.description,
    required this.primaryRecovery,
  });

  final RouteErrorKind kind;
  final String title;
  final String description;
  final RouteRecovery primaryRecovery;
}

/// 例外をユーザー向けエラー種別へ分類する。
RouteErrorKind classifyRouteError(Object error) {
  if (error is RouteException) {
    switch (error.status) {
      case 'NO_ORIGIN':
        return RouteErrorKind.noLocation;
      case 'NO_DESTINATION':
        return RouteErrorKind.noDestination;
      case 'ZERO_RESULTS':
      case 'NOT_FOUND':
        return RouteErrorKind.noResults;
      case 'UNKNOWN_ERROR':
      case 'UNKNOWN':
      case 'OVER_QUERY_LIMIT':
      // TIMEOUT: サービス最下層が TimeoutException を変換したもの（#156）。無応答は
      // 通信状況の問題なので network 扱いで「通信に失敗しました／再試行」に落とす。
      case 'TIMEOUT':
        return RouteErrorKind.network;
    }
    if (error.status.startsWith('HTTP')) return RouteErrorKind.network;
    // NO_PROXY / REQUEST_DENIED / INVALID_REQUEST など設定・権限系。
    return RouteErrorKind.unknown;
  }
  // SocketException / HttpException / HandshakeException など dart:io 系、
  // TimeoutException、http パッケージの ClientException は通信系として扱う。
  if (error is IOException ||
      error is TimeoutException ||
      error is http.ClientException) {
    return RouteErrorKind.network;
  }
  return RouteErrorKind.unknown;
}

RouteErrorView routeErrorView(AppLocalizations l10n, RouteErrorKind kind) =>
    switch (kind) {
      RouteErrorKind.network => RouteErrorView(
        kind: RouteErrorKind.network,
        title: l10n.routeErrorNetworkTitle,
        description: l10n.routeErrorNetworkDescription,
        primaryRecovery: RouteRecovery.retry,
      ),
      RouteErrorKind.noResults => RouteErrorView(
        kind: RouteErrorKind.noResults,
        title: l10n.routeErrorNoResultsTitle,
        description: l10n.routeErrorNoResultsDescription,
        primaryRecovery: RouteRecovery.changeConditions,
      ),
      RouteErrorKind.noLocation => RouteErrorView(
        kind: RouteErrorKind.noLocation,
        title: l10n.routeErrorNoLocationTitle,
        description: l10n.routeErrorNoLocationDescription,
        primaryRecovery: RouteRecovery.retry,
      ),
      RouteErrorKind.noDestination => RouteErrorView(
        kind: RouteErrorKind.noDestination,
        title: l10n.routeErrorNoDestinationTitle,
        description: l10n.routeErrorNoDestinationDescription,
        primaryRecovery: RouteRecovery.changeConditions,
      ),
      RouteErrorKind.unknown => RouteErrorView(
        kind: RouteErrorKind.unknown,
        title: l10n.routeErrorUnknownTitle,
        description: l10n.routeErrorUnknownDescription,
        primaryRecovery: RouteRecovery.retry,
      ),
    };
