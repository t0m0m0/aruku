// 移植元: lib/core/models/route_error.dart
//
// 文言と復帰導線と対で意味を持つので、エラー画面のスライスまで運んでいなかったもの
// （PORTING.md の「まだ運んでいないもの」）。

import {
  ClientException,
  TimeoutException,
} from '@aruku/engine/services/http-client';
import { RouteException } from '@aruku/engine/services/route-service';

import { ja } from '../i18n/ja';
import { RouteErrorKind } from './app-state';

/// エラー画面で主に提示する復帰アクション。
export const RouteRecovery = {
  retry: 'retry',
  changeConditions: 'changeConditions',
} as const;
export type RouteRecovery = (typeof RouteRecovery)[keyof typeof RouteRecovery];

export interface RouteErrorView {
  readonly kind: RouteErrorKind;
  readonly title: string;
  readonly description: string;
  readonly primaryRecovery: RouteRecovery;
}

/// エンジンが投げる `RouteException` のステータス → ユーザー向け種別。
///
/// 移植元にあった `NOT_FOUND` / `UNKNOWN_ERROR` / `UNKNOWN` / `OVER_QUERY_LIMIT` は
/// 運んでいない。NAVITIME 時代の名残で、#330 の撤去以降は Dart のサービス層も
/// これらを投げない（実際に投げているのは下の6つと `HTTP <code>` だけ）。
const kindByStatus: Readonly<Record<string, RouteErrorKind>> = {
  NO_ORIGIN: RouteErrorKind.noLocation,
  NO_DESTINATION: RouteErrorKind.noDestination,
  ZERO_RESULTS: RouteErrorKind.noResults,
  // 上流の遅延は通信断ではない。network へ丸めると「通信状況を確認して再試行」が
  // 電波の正常なユーザーを的外れな導線へ送る（#300 の切り分けで障害になった点）。
  TIMEOUT: RouteErrorKind.timeout,
  // 設定・配線の失敗。ユーザーの操作では直らないので、再試行も条件変更も勧めない。
  NO_TRANSIT_API: RouteErrorKind.unknown,
  MATRIX_NOT_ARRAY: RouteErrorKind.unknown,
};

/// 例外をユーザー向けエラー種別へ分類する。
export function classifyRouteError(error: unknown): RouteErrorKind {
  if (error instanceof RouteException) {
    const known = kindByStatus[error.status];
    if (known !== undefined) return known;
    if (error.status.startsWith('HTTP')) return RouteErrorKind.network;
    return RouteErrorKind.unknown;
  }

  // ドメイン例外へ変換される前に漏れたタイムアウト。
  if (error instanceof TimeoutException) return RouteErrorKind.timeout;

  // 通信の失敗はトランスポート層が ClientException へ寄せて届く
  // （fetch-http-client.ts の `asClientException`。`TypeError: Failed to fetch` も含む）。
  //
  // 移植元は dart:io の IOException と http の ClientException を**両方**見ていた。
  // dart2js の dart:io がスタブで Web の通信断が IOException に一致しないため（#359）。
  // こちらは層が1つに揃えているので、その二重性は運ばない。
  //
  // 裏返しとして、**素の TypeError をここで拾ってはいけない**。通信由来のものは上記の
  // とおり包まれて届くので、ここへ来る TypeError は我々のバグ——network に寄せると
  // 「通信状況を確認してください」として、ユーザーにも我々にも見えなくなる。
  if (error instanceof ClientException) return RouteErrorKind.network;

  return RouteErrorKind.unknown;
}

const viewByKind: Readonly<Record<RouteErrorKind, Omit<RouteErrorView, 'kind'>>> = {
  [RouteErrorKind.network]: {
    title: ja.routeErrorNetworkTitle,
    description: ja.routeErrorNetworkDescription,
    primaryRecovery: RouteRecovery.retry,
  },
  [RouteErrorKind.timeout]: {
    title: ja.routeErrorTimeoutTitle,
    description: ja.routeErrorTimeoutDescription,
    primaryRecovery: RouteRecovery.retry,
  },
  [RouteErrorKind.noResults]: {
    title: ja.routeErrorNoResultsTitle,
    description: ja.routeErrorNoResultsDescription,
    // 同じ条件で再試行しても同じ結果になる。勧めるのは条件の変更。
    primaryRecovery: RouteRecovery.changeConditions,
  },
  [RouteErrorKind.noLocation]: {
    title: ja.routeErrorNoLocationTitle,
    description: ja.routeErrorNoLocationDescription,
    primaryRecovery: RouteRecovery.retry,
  },
  [RouteErrorKind.noDestination]: {
    title: ja.routeErrorNoDestinationTitle,
    description: ja.routeErrorNoDestinationDescription,
    primaryRecovery: RouteRecovery.changeConditions,
  },
  [RouteErrorKind.unknown]: {
    title: ja.routeErrorUnknownTitle,
    description: ja.routeErrorUnknownDescription,
    primaryRecovery: RouteRecovery.retry,
  },
};

export function routeErrorView(kind: RouteErrorKind): RouteErrorView {
  return { kind, ...viewByKind[kind] };
}
