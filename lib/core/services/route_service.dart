import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'navitime_route_service.dart';

/// ルート計算の進捗段階。ローディング表示の3ステップに対応する。
enum RoutePhase { routing, walkability, building }

abstract interface class RouteService {
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
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
  final client = http.Client();
  ref.onDispose(client.close);
  return NaviTimeRouteService(client: client);
});
