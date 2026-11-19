import { appConfig } from '../config';
import { GooglePlacesService, type PlacesService } from '../places/places-service';
import type { Fetch } from '../http/fetch-http-client';
import { createProxyClient, type AppCheckProviders } from './route-service';

export interface PlacesServiceOptions {
  readonly proxyBaseUrl?: string;
  readonly appCheck: AppCheckProviders;

  readonly fetch?: Fetch;
}

export function createPlacesService(options: PlacesServiceOptions): PlacesService {
  return new GooglePlacesService({
    client: createProxyClient({
      appCheck: options.appCheck,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    proxyBaseUrl: options.proxyBaseUrl ?? appConfig.proxyBaseUrl,
  });
}
