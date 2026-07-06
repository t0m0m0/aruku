import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/models/geo_point.dart';
import '../../core/models/route_plan.dart';
import '../../core/navigation/nav_engine.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/extensions/route_map_overlays.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';
import '../../shared/widgets/aruku_map.dart';

part 'nav_widgets.dart';

/// ナビ視点（zoom17/tilt45）を維持したまま [pos] を中心とするカメラ位置。
CameraPosition navCameraPosition(GeoPoint pos) => CameraPosition(
  target: LatLng(pos.lat, pos.lng),
  zoom: ArukuMapVariant.nav.zoom,
  tilt: ArukuMapVariant.nav.tilt,
);

class NavScreen extends ConsumerStatefulWidget {
  const NavScreen({super.key});

  @override
  ConsumerState<NavScreen> createState() => _NavScreenState();
}

class _NavScreenState extends ConsumerState<NavScreen> {
  GoogleMapController? _mapController;
  MapType _mapType = MapType.normal;

  /// 直前フレームでのポリライン沿い累積距離（メートル）。自己交差・並走
  /// 区間でのスナップジャンプを防ぐため [computeGuidance] へ渡す。
  /// 経路が変わったら（再検索等）無効なので破棄する。
  double? _lastDistanceAlongMeters;
  RoutePlan? _lastRouteForDistance;

  void _toggleLayer() {
    setState(() {
      _mapType = _mapType == MapType.normal ? MapType.hybrid : MapType.normal;
    });
  }

  /// コンパス: 現在地を中心に北向き（bearing 0）へ戻す。
  void _resetNorth() {
    final pos = ref.read(appStateProvider).currentPosition;
    final controller = _mapController;
    if (pos == null || controller == null) return;
    controller.animateCamera(
      CameraUpdate.newCameraPosition(navCameraPosition(pos)),
    );
  }

  /// ルート全体俯瞰フィット完了後、現在地が既にあればナビ視点へ切り替える。
  void _snapToNavCamera(GoogleMapController controller) {
    final pos = ref.read(appStateProvider).currentPosition;
    if (pos == null) return;
    controller.animateCamera(
      CameraUpdate.newCameraPosition(navCameraPosition(pos)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final state = ref.watch(appStateProvider);
    final route = state.route;
    final current = state.currentPosition;

    // 実移動に追従して地図カメラを現在地へ寄せる。
    ref.listen(appStateProvider.select((s) => s.currentPosition), (_, next) {
      if (next != null) {
        _mapController?.animateCamera(
          CameraUpdate.newCameraPosition(navCameraPosition(next)),
        );
      }
    });

    if (route != _lastRouteForDistance) {
      _lastRouteForDistance = route;
      _lastDistanceAlongMeters = null;
    }
    final guidance = (route != null && current != null)
        ? computeGuidance(
            route: route,
            current: current,
            previousDistanceAlongMeters: _lastDistanceAlongMeters,
          )
        : null;
    if (guidance != null) {
      _lastDistanceAlongMeters = guidance.traveledKm * 1000;
    }

    final totalKm = guidance?.totalKm ?? route?.totalKm ?? 0.0;
    final markers = <Marker>{
      if (route != null) ...route.toMarkers(),
      if (current != null)
        Marker(
          markerId: const MarkerId('current'),
          position: LatLng(current.lat, current.lng),
          icon: BitmapDescriptor.defaultMarkerWithHue(
            BitmapDescriptor.hueAzure,
          ),
        ),
    };

    return Material(
      color: c.mapBg,
      child: Stack(
        children: [
          // Full-bleed map
          Positioned.fill(
            child: ArukuMap(
              variant: ArukuMapVariant.nav,
              polylines: route?.toPolylines() ?? const {},
              markers: markers,
              routeBounds: route?.toBounds(),
              mapType: _mapType,
              onMapReady: (controller) => _mapController = controller,
              onFitBoundsComplete: _snapToNavCamera,
            ),
          ),

          SafeArea(
            child: Column(
              children: [
                // Top instruction card
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                  child: _InstructionCard(
                    guidance: guidance,
                    destination: route?.to,
                  ),
                ),
                if (state.isRerouting)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(12, 8, 12, 0),
                    child: _RerouteBanner(),
                  ),
                const Spacer(),
                // Bottom stats bar
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                  child: _StatsBar(
                    traveledKm: guidance?.traveledKm ?? 0.0,
                    totalKm: totalKm,
                    progress: guidance?.progress ?? 0.0,
                    remainingKm: guidance?.remainingKm ?? totalKm,
                    arrivalTime: guidance != null
                        ? _formatArrival(guidance.etaMinutesRemaining)
                        : state.arrival.format(),
                    consumedKcal: guidance?.consumedKcal ?? state.todayKcal,
                    onExit: () => notifier.go(Screen.home),
                  ),
                ),
              ],
            ),
          ),

          // Right controls
          Positioned(
            right: 12,
            top: 220,
            child: Column(
              children: [
                _NavChip(
                  key: const Key('nav-layer-chip'),
                  icon: Ic.layers(size: 20, color: c.ink2),
                  onTap: _toggleLayer,
                ),
                const SizedBox(height: 8),
                _NavChip(
                  key: const Key('nav-compass-chip'),
                  icon: Ic.compass(size: 20, color: c.ink2),
                  onTap: _resetNorth,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 現在時刻に残り分を足した到着予定時刻を "HH:mm" で返す。
String _formatArrival(int minutesRemaining) {
  final t = DateTime.now().add(Duration(minutes: minutesRemaining));
  return '${t.hour.toString().padLeft(2, '0')}:'
      '${t.minute.toString().padLeft(2, '0')}';
}
