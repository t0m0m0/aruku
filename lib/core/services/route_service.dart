import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'app_check_http_client.dart';
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
  });
}

class RouteException implements Exception {
  const RouteException(this.status);
  final String status;

  @override
  String toString() => 'RouteException($status)';
}

final routeServiceProvider = Provider<RouteService>((ref) {
  // Transit API は直叩き（認証不要・CORS）、Google 徒歩プロキシは App Check 必須。
  // TimeoutHttpClient は最外側に置き、App Check の getToken を含む全体を打ち切る（#156）。
  final transitClient = TimeoutHttpClient(http.Client());
  final proxyClient = TimeoutHttpClient(AppCheckHttpClient(http.Client()));
  ref.onDispose(transitClient.close);
  ref.onDispose(proxyClient.close);
  return TransitRouteService(
    transitClient: transitClient,
    proxyClient: proxyClient,
  );
});
