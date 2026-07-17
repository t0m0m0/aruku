import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'app_check_http_client.dart';
import 'cancellation.dart';
import 'search_deadline.dart';
import 'timeout_http_client.dart';
import 'transit_api_client.dart';
import 'transit_route_service.dart';

/// ルート計算の進捗段階。ローディング表示の3ステップに対応する。
enum RoutePhase { routing, walkability, building }

abstract interface class RouteService {
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,

    /// 検索単位のキャンセル境界（#259）。倒すと進行中の HTTP を切り、以降の
    /// 外部呼び出しを止める。null なら中断不能。
    CancellationToken? cancellation,
  });
}

/// 検索1回分の実体。HTTP クライアントを所有し、[close] でそのソケットごと落とす。
/// キャンセル可能にするために「エンジン＝検索の寿命」とし、[SearchScopedRouteService]
/// が plan ごとに組み立てて捨てる（#259）。
abstract interface class SearchEngine {
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  });

  /// 所有する HTTP クライアントを閉じ、in-flight を中断する。
  void close();
}

/// キャンセル可能な検索エンジンを組み立てる工場。トークンをエンジン内部の
/// [TransitApiClient] まで通し、送信前チェックを効かせる（#259）。
typedef SearchEngineFactory = SearchEngine Function(CancellationToken);

class RouteException implements Exception {
  const RouteException(this.status);
  final String status;

  @override
  String toString() => 'RouteException($status)';
}

/// plan 呼び出しごとに使い捨ての [SearchEngine] を組み立て、終了（正常・異常・
/// キャンセル）で必ず閉じる薄い façade（#259）。
///
/// エンジンを検索寿命にするのは、[TransitRouteService] が単一の [TransitApiClient]
/// を多数のメソッドで共有しており、可変フィールドでトークンを差し替えると
/// キャンセル直後の再検索と client を取り合ってしまうため。1検索1インスタンスなら
/// その競合が構造的に起きない。
class SearchScopedRouteService implements RouteService {
  const SearchScopedRouteService(this._buildEngine);

  final SearchEngineFactory _buildEngine;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
    CancellationToken? cancellation,
  }) async {
    final token = cancellation ?? CancellationToken();
    final engine = _buildEngine(token);

    var closed = false;
    void closeOnce() {
      if (closed) return;
      closed = true;
      engine.close();
    }

    // キャンセルは plan の完了を待たずに即 close する。await 中に走っている
    // fetch のソケットをその場で落とすのが中断の本体（#259）。
    token.onCancel(closeOnce);
    try {
      final result = await engine.plan(
        destination: destination,
        destinationLatLng: destinationLatLng,
        departure: departure,
        arrival: arrival,
        origin: origin,
        originName: originName,
        onProgress: onProgress,
      );
      token.throwIfCanceled();
      return result;
    } catch (_) {
      // close で in-flight が落ちると get は任意の通信例外になる。キャンセル
      // 済みならそれを [SearchCanceledException] へ揃え、呼び出し側が通信障害と
      // 取り違えないようにする。未キャンセルの素の失敗はそのまま伝播する。
      token.throwIfCanceled();
      rethrow;
    } finally {
      closeOnce();
    }
  }
}

/// Transit API 直叩き1本あたりの応答待ち上限（#300）。
///
/// `[TimeoutHttpClient]` の既定 15 秒を共有していたが、上流 `/guidance/plan` は
/// 9〜11 秒が正常・裾は 30 秒超（2026-06-27／2026-07-17 実測。
/// docs/notes/transit-api-migration.md §1.1-5・§8）で、正常時ですら余裕が約4秒
/// しかなく、実機で経路検索が落ち続けた。実測サンプルの最大 30.8 秒を収める 35 秒
/// にする。上流は無料・無認証・無 SLA の第三者 API で、遅さは相手の性質＝交渉手段が
/// 無い。動かせるのは我々側だけという前提で「裾を切る」より「裾を待つ」を選んでいる。
///
/// 延ばしても最悪待ち時間が膨らまないのは [SearchDeadline] が別に天井を張るため。
/// 片方だけでは成立しない（この値だけ延ばすと最悪＝値×直列ラウンド数）。
const transitRequestTimeout = Duration(seconds: 35);

/// 徒歩プロキシ1本あたりの応答待ち上限（#300）。Cloud Functions 経由の Google Routes は
/// Transit API のような裾を持たないため [TimeoutHttpClient] の既定（15 秒）に据え置く。
/// 直叩きと同じ 35 秒にしないのは、プロキシの無応答は本当に異常＝早く縮退した方が
/// 良いから（徒歩は直線推定へ落とせる）。
const proxyRequestTimeout = Duration(seconds: 15);

/// 検索1回分の待ち時間の天井（#300）。超過後は引き直しを打ち切り、既得の候補で確定する。
///
/// 正常時の検索は初期 guidance(~10s)＋乗車駅探索の引き直しで 30〜60 秒（§8）。120 秒は
/// その上に裾（30 秒級）が数本重なっても引き直しを完走できる幅を残しつつ、最悪を
/// 120 秒で止める。天井が厳密に効くのは [TransitApiClient] が残予算で各 fetch を
/// クランプするため——新ラウンドを止めるだけでは最悪が「締切＋1本の上限」になる。
const searchDeadlineBudget = Duration(seconds: 120);

final routeServiceProvider = Provider<RouteService>((ref) {
  // 検索1回ごとにクライアントを作って捨てる（#259）。検索内のファンアウト（最大
  // 13本）では keep-alive が効き、捨てるのは検索をまたぐ接続再利用だけ。キャンセル時
  // に close して in-flight を切るには、この per-search 所有が要る。
  return SearchScopedRouteService((cancellation) {
    // Transit API は直叩き（認証不要・CORS）、Google 徒歩プロキシは App Check 必須。
    // TimeoutHttpClient は最外側に置き、App Check の getToken を含む全体を打ち切る（#156）。
    final transitClient = TimeoutHttpClient(
      http.Client(),
      timeout: transitRequestTimeout,
    );
    final proxyClient = TimeoutHttpClient(
      AppCheckHttpClient(http.Client()),
      timeout: proxyRequestTimeout,
    );
    return TransitRouteService(
      transitClient: transitClient,
      proxyClient: proxyClient,
      cancellation: cancellation,
      // 締切は検索ごとに作る。engine の生成が plan() の入口なので、ここで作れば
      // 計測開始＝検索開始になる（#300）。
      deadline: SearchDeadline(searchDeadlineBudget),
    );
  });
});
