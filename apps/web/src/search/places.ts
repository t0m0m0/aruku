// 移植元: flutter-final:lib/core/services/places_service.dart の `placesServiceProvider`。
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
/// typeahead の古い要求は要求単位の signal で中止する（#488・search-state.ts）ので、
/// 中止のために client を作り直す必要が無い。close() はサービス全体の終了。
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
