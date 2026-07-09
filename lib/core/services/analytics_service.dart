import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 収益化方針（#237）の実測データ収集用の計測サービス。
///
/// 既定実装は [NoopAnalyticsService]（何もしない）。実機ビルドでのみ
/// [FirebaseAnalyticsService] を注入し、[analyticsServiceProvider] を上書きする
/// （テスト・Firebase未初期化環境で誤って実送信しないため）。
abstract interface class AnalyticsService {
  /// 検索を実行した（[AppNotifier.startSearch] 起動時）。
  void logSearchRequested();

  /// 乗車駅探索フォールバックが発動した（崩壊判定でstandardルートが使えず
  /// 探索し直す・§7）。発動時点までに叩いたAPI回数を添えて、どこまで通信して
  /// から縮退したかを追える。
  void logSearchFallbackTriggered({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
  });

  /// 1検索で実際に叩いたAPI呼び出し回数（NAVITIME/Google Routes/Matrix）。
  /// [fallbackTriggered] は乗車駅探索フォールバックが発動したか。
  void logSearchApiCalls({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
    required bool fallbackTriggered,
  });
}

/// 連携先を持たない既定実装。プラグイン未初期化の環境（テスト・シミュレータ）
/// で安全に no-op として振る舞う。
class NoopAnalyticsService implements AnalyticsService {
  const NoopAnalyticsService();

  @override
  void logSearchRequested() {}

  @override
  void logSearchFallbackTriggered({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
  }) {}

  @override
  void logSearchApiCalls({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
    required bool fallbackTriggered,
  }) {}
}

/// [FirebaseAnalytics] を用いた実体。
class FirebaseAnalyticsService implements AnalyticsService {
  FirebaseAnalyticsService(this._analytics);

  final FirebaseAnalytics _analytics;

  @override
  void logSearchRequested() {
    _analytics.logEvent(name: 'search_requested');
  }

  @override
  void logSearchFallbackTriggered({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
  }) {
    _analytics.logEvent(
      name: 'search_fallback_triggered',
      parameters: {
        'navitime_calls': navitimeCalls,
        'google_walk_calls': googleWalkCalls,
        'google_matrix_calls': googleMatrixCalls,
      },
    );
  }

  @override
  void logSearchApiCalls({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
    required bool fallbackTriggered,
  }) {
    _analytics.logEvent(
      name: 'search_api_calls',
      parameters: {
        'navitime_calls': navitimeCalls,
        'google_walk_calls': googleWalkCalls,
        'google_matrix_calls': googleMatrixCalls,
        'fallback_triggered': fallbackTriggered,
      },
    );
  }
}

final analyticsServiceProvider = Provider<AnalyticsService>(
  (_) => const NoopAnalyticsService(),
);
