// 移植元: lib/core/services/places_service.dart の `placesServiceProvider`。
//
// route-service.ts と同じく、これは DI の配線であってサービスの仕様ではない。

import { appConfig } from '../config';
import { GooglePlacesService, type PlacesService } from '../places/places-service';
import type { Fetch } from '../http/fetch-http-client';
import { createProxyClient, type AppCheckProviders } from './route-service';

export interface PlacesServiceOptions {
  readonly proxyBaseUrl?: string;
  readonly appCheck: AppCheckProviders;

  /// テストから実ネットワークを外すための差し替え口。
  readonly fetch?: Fetch;
}

/// placesProxy を叩く地点検索を組み立てる。
///
/// 経路検索（createRouteService）と違い、検索1回ごとに作って捨てる形にしていない。
/// 地点検索に中断の要求が無く、クライアントの寿命を画面に合わせれば typeahead の
/// 連続要求で keep-alive がそのまま効く。
///
/// placesProxy はサーバが consume:true で検証する（リプレイ保護・#155）。
/// createProxyClient 越しに通すことで使い捨てトークンが付く。
export function createPlacesService(
  options: PlacesServiceOptions,
): PlacesService {
  return new GooglePlacesService({
    client: createProxyClient({
      appCheck: options.appCheck,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    proxyBaseUrl: options.proxyBaseUrl ?? appConfig.proxyBaseUrl,
  });
}
