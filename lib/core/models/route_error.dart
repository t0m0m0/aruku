import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../../l10n/app_localizations.dart';
import '../services/route_service.dart';

/// ルート計算失敗の種別。UI の文言と復帰導線の出し分けに使う。
enum RouteErrorKind {
  network,
  timeout,
  noResults,
  noLocation,
  noDestination,
  unknown,
}

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
      // TIMEOUT: サービス最下層が TimeoutException を変換したもの（#156）と、検索の
      // 締切による打ち切り（#300）。network に丸めない——上流 Transit API の遅延は
      // 通信断ではなく、「通信状況を確認して再試行」は電波が正常なユーザーを的外れな
      // 導線へ送る。#300 の切り分けでは、画面表示から App Check 拒否・レート制限・
      // 上流遅延を区別できないこと自体が障害になった。
      case 'TIMEOUT':
        return RouteErrorKind.timeout;
    }
    if (error.status.startsWith('HTTP')) return RouteErrorKind.network;
    // NO_PROXY / REQUEST_DENIED / INVALID_REQUEST など設定・権限系。
    return RouteErrorKind.unknown;
  }
  // 素の TimeoutException（ドメイン例外へ変換される前に漏れたもの）も遅延として扱う。
  if (error is TimeoutException) return RouteErrorKind.timeout;
  // SocketException / HttpException / HandshakeException など dart:io 系、
  // http パッケージの ClientException は通信系として扱う。
  if (error is IOException || error is http.ClientException) {
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
      RouteErrorKind.timeout => RouteErrorView(
        kind: RouteErrorKind.timeout,
        title: l10n.routeErrorTimeoutTitle,
        description: l10n.routeErrorTimeoutDescription,
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
