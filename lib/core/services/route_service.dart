import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'app_check_http_client.dart';
import 'cancellation.dart';
import 'timeout_http_client.dart';
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

final routeServiceProvider = Provider<RouteService>((ref) {
  // 検索1回ごとにクライアントを作って捨てる（#259）。検索内のファンアウト（最大
  // 13本）では keep-alive が効き、捨てるのは検索をまたぐ接続再利用だけ。キャンセル時
  // に close して in-flight を切るには、この per-search 所有が要る。
  return SearchScopedRouteService((cancellation) {
    // Transit API は直叩き（認証不要・CORS）、Google 徒歩プロキシは App Check 必須。
    // TimeoutHttpClient は最外側に置き、App Check の getToken を含む全体を打ち切る（#156）。
    final transitClient = TimeoutHttpClient(http.Client());
    final proxyClient = TimeoutHttpClient(AppCheckHttpClient(http.Client()));
    return TransitRouteService(
      transitClient: transitClient,
      proxyClient: proxyClient,
      cancellation: cancellation,
    );
  });
});
