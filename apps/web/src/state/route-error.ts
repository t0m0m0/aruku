import { ClientException, TimeoutException } from '@aruku/engine/services/http-client';
import { RouteException } from '@aruku/engine/services/route-service';

import { ja } from '../i18n/ja';
import { RouteErrorKind } from './app-state';

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

const kindByStatus: Readonly<Partial<Record<string, RouteErrorKind>>> = {
  NO_ORIGIN: RouteErrorKind.noLocation,
  NO_DESTINATION: RouteErrorKind.noDestination,
  ZERO_RESULTS: RouteErrorKind.noResults,
  TIMEOUT: RouteErrorKind.timeout,
  NO_TRANSIT_API: RouteErrorKind.unknown,
  MATRIX_NOT_ARRAY: RouteErrorKind.unknown,
};

export function classifyRouteError(error: unknown): RouteErrorKind {
  if (error instanceof RouteException) {
    const known = kindByStatus[error.status];
    if (known !== undefined) return known;
    if (error.status.startsWith('HTTP')) return RouteErrorKind.network;
    return RouteErrorKind.unknown;
  }

  if (error instanceof TimeoutException) return RouteErrorKind.timeout;

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
