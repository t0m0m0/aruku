import type { CancellationToken } from '@aruku/engine/services/cancellation';
import {
  proxyRequestTimeout,
  searchDeadlineBudget,
  transitRequestTimeout,
  SearchScopedRouteService,
  type RouteService,
} from '@aruku/engine/services/route-service';
import { SearchDeadline } from '@aruku/engine/services/search-deadline';
import { TransitRouteService } from '@aruku/engine/services/transit-route-service';
import type { Duration } from '@aruku/engine/time';

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

/// Transit API 直叩き用。認証不要・CORS 対応なので App Check を通さない。
export function createTransitClient(
  options: TransitClientOptions = {},
): TimeoutHttpClient {
  return new TimeoutHttpClient(new FetchHttpClient({ fetch: options.fetch }), {
    timeout: options.timeout ?? transitRequestTimeout,
  });
}

/// Cloud Functions プロキシ用。App Check 必須。
///
/// タイムアウトを最外側に置くのは、トークン取得のハングも上限の内側へ収めるため
/// （#156。app-check-http-client.test.ts の合成テスト）。
export function createProxyClient(options: ProxyClientOptions): TimeoutHttpClient {
  return new TimeoutHttpClient(
    new AppCheckHttpClient(
      new FetchHttpClient({ fetch: options.fetch }),
      options.appCheck,
    ),
    { timeout: options.timeout ?? proxyRequestTimeout },
  );
}

export interface RouteServiceOptions {
  readonly transitBaseUrl: string;
  readonly proxyBaseUrl: string;
  readonly appCheck: AppCheckProviders;

  /// テストから実ネットワークを外すための差し替え口。
  readonly fetch?: Fetch;
}

/// 移植元: lib/core/services/route_service.dart の `routeServiceProvider`。
///
/// 検索1回ごとにクライアントを作って捨てる（#259）。検索内のファンアウト（最大13本）
/// では keep-alive が効き、捨てるのは検索をまたぐ接続再利用だけ。キャンセル時に
/// close して in-flight を切るには、この per-search 所有が要る。
export function createRouteService(options: RouteServiceOptions): RouteService {
  requireAbsoluteBase(options.transitBaseUrl, 'VITE_TRANSIT_API_BASE_URL');
  requireAbsoluteBase(options.proxyBaseUrl, 'VITE_PROXY_BASE_URL');

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
      // 締切は検索ごとに作る。エンジンの生成が plan() の入口なので、ここで作れば
      // 計測開始＝検索開始になる（#300）。
      deadline: new SearchDeadline(searchDeadlineBudget),
    });
  });
}

/// ベース URL が絶対 URL であることを組み立て時に確かめる。
///
/// 空のまま渡すとエンジンが `new URL('/googleWalkMatrixProxy')` を評価する瞬間に
/// TypeError で倒れる。移植元は `Uri.parse` が相対 URI を作れたので同じ穴が無い。
///
/// RouteException にしないのはエンジンの先例に倣う——配線漏れを RouteException に
/// すると縮退パス（候補ドロップ・直線推定）に握り潰され、設定漏れが「徒歩が長い経路」
/// として静かに出てしまう（transit-api-client.ts の 'no HTTP client was injected'）。
/// 環境変数名を載せるのは、バンドル後のスタックからは出どころが読めないため。
function requireAbsoluteBase(base: string, envName: string): void {
  if (base !== '' && URL.canParse(base)) return;
  throw new Error(
    `createRouteService: ${envName} が絶対 URL ではありません（受け取った値: ${JSON.stringify(base)}）。` +
      'dart_defines.example.json 相当の設定を .env へ用意してください。',
  );
}
