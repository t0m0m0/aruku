import type { CancellationToken } from '@aruku/engine/services/cancellation';
import {
  proxyRequestTimeout,
  searchDeadlineBudget,
  transitRequestTimeout,
  SearchScopedRouteService,
  type RouteService,
} from '@aruku/engine/services/route-service';
import type { RouteSearchMetrics } from '@aruku/engine/services/route-diagnostics';
import { SearchDeadline } from '@aruku/engine/services/search-deadline';
import { TransitRouteService } from '@aruku/engine/services/transit-route-service';
import type { Duration } from '@aruku/engine/time';

import { requireUsableBase } from '../http/base-url';
import type { AppCheckTokenProvider } from '../http/app-check-http-client';
import { AppCheckHttpClient } from '../http/app-check-http-client';
import { FetchHttpClient, type Fetch } from '../http/fetch-http-client';
import { TimeoutHttpClient } from '../http/timeout-http-client';

export interface AppCheckProviders {
  readonly tokenProvider: AppCheckTokenProvider;
  readonly limitedUseTokenProvider: AppCheckTokenProvider;
}

export interface TransitClientOptions {
  readonly fetch?: Fetch;
  readonly timeout?: Duration;
}

export interface ProxyClientOptions extends TransitClientOptions {
  readonly appCheck: AppCheckProviders;
}

export function createTransitClient(options: TransitClientOptions = {}): TimeoutHttpClient {
  return new TimeoutHttpClient(new FetchHttpClient({ fetch: options.fetch }), {
    timeout: options.timeout ?? transitRequestTimeout,
  });
}

export function createProxyClient(options: ProxyClientOptions): TimeoutHttpClient {
  return new TimeoutHttpClient(
    new AppCheckHttpClient(new FetchHttpClient({ fetch: options.fetch }), options.appCheck),
    { timeout: options.timeout ?? proxyRequestTimeout },
  );
}

export interface RouteServiceOptions {
  readonly transitBaseUrl: string;
  readonly proxyBaseUrl: string;
  readonly appCheck: AppCheckProviders;

  readonly exactWalkMax?: boolean;

  readonly exactWalkMaxAb?: boolean;

  readonly rideDepartures?: boolean;

  readonly onMetrics?: (metrics: RouteSearchMetrics) => void;

  readonly fetch?: Fetch;
}

export function createRouteService(options: RouteServiceOptions): RouteService {
  requireUsableBase(options.transitBaseUrl, 'VITE_TRANSIT_API_BASE_URL', 'createRouteService');
  requireUsableBase(options.proxyBaseUrl, 'VITE_PROXY_BASE_URL', 'createRouteService');

  return new SearchScopedRouteService((cancellation: CancellationToken) => {
    return new TransitRouteService({
      transitClient: createTransitClient({ fetch: options.fetch }),
      proxyClient: createProxyClient({
        appCheck: options.appCheck,
        fetch: options.fetch,
      }),
      transitBaseUrl: options.transitBaseUrl,
      proxyBaseUrl: options.proxyBaseUrl,
      cancellation,
      exactWalkMax: options.exactWalkMax ?? false,
      exactWalkMaxAb: options.exactWalkMaxAb ?? false,
      rideDepartures: options.rideDepartures ?? false,
      onMetrics: options.onMetrics,
      deadline: new SearchDeadline(searchDeadlineBudget),
    });
  });
}
