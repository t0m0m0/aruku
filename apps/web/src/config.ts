/// 移植元: lib/core/config/app_config.dart のうち Web で意味のあるもの。
///
/// 歩数・HealthKit・ローカル通知まわりの設定は移していない。Web では恒久的に
/// 動かない機能として #386 で UI ごと作らないと決めたため。

/// 経路検索（Transit API）のベース URL の既定。移植元の `transitApiBaseUrl` と同じ。
const defaultTransitApiBaseUrl = 'https://api.transit.ls8h.com';

export interface AppConfig {
  /// Cloud Functions プロキシのベース URL。未設定だとプロキシ経由の徒歩実測が
  /// 全て失敗し、経路は直線推定へ縮退する。
  readonly proxyBaseUrl: string;

  readonly transitApiBaseUrl: string;
}

export const appConfig: AppConfig = {
  proxyBaseUrl: import.meta.env.VITE_PROXY_BASE_URL ?? '',
  transitApiBaseUrl:
    import.meta.env.VITE_TRANSIT_API_BASE_URL ?? defaultTransitApiBaseUrl,
};
