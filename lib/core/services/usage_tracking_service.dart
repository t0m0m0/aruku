import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 検索回数カウンタ（`users/{uid}/usage/{yyyyMM}`）への加算依頼（#238）。
///
/// 加算そのものはクライアントから直接 Firestore に書き込まず、必ず Cloud Functions
/// （`recordSearchUsage`）側のトランザクションで行う。クライアントは呼び出すだけで、
/// 失敗しても検索結果の表示は妨げない（ベストエフォート・計測用途のため）。
///
/// 既定実装は [NoopUsageTrackingService]（何もしない）。実機ビルドでのみ
/// [CloudFunctionsUsageTrackingService] を注入し、[usageTrackingServiceProvider] を
/// 上書きする（テスト・Firebase未初期化環境で誤って実呼び出ししないため）。
abstract interface class UsageTrackingService {
  /// 検索が成功した（結果画面へ遷移した）ことを記録する。
  Future<void> recordSearch();
}

/// 連携先を持たない既定実装。プラグイン未初期化の環境（テスト・シミュレータ）
/// で安全に no-op として振る舞う。
class NoopUsageTrackingService implements UsageTrackingService {
  const NoopUsageTrackingService();

  @override
  Future<void> recordSearch() async {}
}

/// [FirebaseFunctions] の callable（`recordSearchUsage`）を呼ぶ実体。
class CloudFunctionsUsageTrackingService implements UsageTrackingService {
  CloudFunctionsUsageTrackingService(this._functions);

  final FirebaseFunctions _functions;

  @override
  Future<void> recordSearch() async {
    // 失敗（ネットワーク・未認証等）しても検索結果表示は妨げない。計測用途で
    // クリティカルパスではないため、ここで握り潰す。
    try {
      await _functions.httpsCallable('recordSearchUsage').call();
    } catch (_) {
      // ベストエフォート: 計測欠損を許容し、検索フローへは伝播させない。
    }
  }
}

final usageTrackingServiceProvider = Provider<UsageTrackingService>(
  (_) => const NoopUsageTrackingService(),
);
