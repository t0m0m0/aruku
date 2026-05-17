import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;

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

RouteErrorView routeErrorView(RouteErrorKind kind) => switch (kind) {
  RouteErrorKind.network => const RouteErrorView(
    kind: RouteErrorKind.network,
    title: '通信に失敗しました',
    description: '通信状況を確認してもう一度お試しください',
    primaryRecovery: RouteRecovery.retry,
  ),
  RouteErrorKind.noResults => const RouteErrorView(
    kind: RouteErrorKind.noResults,
    title: 'ルートが見つかりませんでした',
    description: '目的地や出発・到着時刻を変えてお試しください',
    primaryRecovery: RouteRecovery.changeConditions,
  ),
  RouteErrorKind.noLocation => const RouteErrorView(
    kind: RouteErrorKind.noLocation,
    title: '現在地を取得できませんでした',
    description: '位置情報を有効にしてもう一度お試しください',
    primaryRecovery: RouteRecovery.retry,
  ),
  RouteErrorKind.noDestination => const RouteErrorView(
    kind: RouteErrorKind.noDestination,
    title: '目的地が選ばれていません',
    description: '目的地を選んでもう一度検索してください',
    primaryRecovery: RouteRecovery.changeConditions,
  ),
  RouteErrorKind.unknown => const RouteErrorView(
    kind: RouteErrorKind.unknown,
    title: 'ルートを取得できませんでした',
    description: '時間をおいてもう一度お試しください',
    primaryRecovery: RouteRecovery.retry,
  ),
};
