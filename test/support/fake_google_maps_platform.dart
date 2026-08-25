import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:google_maps_flutter_platform_interface/google_maps_flutter_platform_interface.dart';

/// `GoogleMapsFlutterPlatform` の差し替え。`dispose(mapId:)` の呼び出しを記録する。
///
/// 既定の `MethodChannelGoogleMapsFlutter` では二重 dispose を観測できない。
/// チャンネル送信は VM のテストで黙って捨てられ、2 回目も 1 回目と区別が付かない
/// ためである。Web 実装だけが `_mapById` という Dart 側の状態を見て失敗する（#362）。
///
/// イベントは `Stream.empty()` を返す。`StreamController` を持つと、購読されない
/// 経路のテストで `close()` が待たれ続けて tearDown がタイムアウトする。
class FakeGoogleMapsPlatform extends GoogleMapsFlutterPlatform {
  /// `dispose` が呼ばれた mapId。二重呼び出しは同じ id が 2 度並ぶ形で現れる。
  final List<int> disposedMapIds = <int>[];

  final Set<int> _viewsCreated = <int>{};

  @override
  Future<void> init(int mapId) async {}

  @override
  void dispose({required int mapId}) => disposedMapIds.add(mapId);

  // `_GoogleMapState` は rebuild ごとに更新系を一通り呼ぶ。既定実装は
  // UnimplementedError を投げるため、破棄の検証に辿り着く前にテストが落ちる。
  @override
  Future<void> updateMapConfiguration(
    MapConfiguration configuration, {
    required int mapId,
  }) async {}

  @override
  Future<void> updateMarkers(
    MarkerUpdates markerUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updatePolygons(
    PolygonUpdates polygonUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updatePolylines(
    PolylineUpdates polylineUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updateCircles(
    CircleUpdates circleUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updateHeatmaps(
    HeatmapUpdates heatmapUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updateClusterManagers(
    ClusterManagerUpdates clusterManagerUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updateGroundOverlays(
    GroundOverlayUpdates groundOverlayUpdates, {
    required int mapId,
  }) async {}

  @override
  Future<void> updateTileOverlays({
    required Set<TileOverlay> newTileOverlays,
    required int mapId,
  }) async {}

  @override
  Widget buildViewWithConfiguration(
    int creationId,
    PlatformViewCreatedCallback onPlatformViewCreated, {
    required MapWidgetConfiguration widgetConfiguration,
    MapConfiguration mapConfiguration = const MapConfiguration(),
    MapObjects mapObjects = const MapObjects(),
  }) {
    // 生成通知は 1 度だけ。build ごとに呼ぶと `_GoogleMapState` の Completer が
    // 二度 complete され、テストが本題と無関係な例外で落ちる。
    if (_viewsCreated.add(creationId)) {
      onPlatformViewCreated(creationId);
    }
    return const SizedBox.expand();
  }

  @override
  Stream<CameraMoveStartedEvent> onCameraMoveStarted({required int mapId}) =>
      const Stream<CameraMoveStartedEvent>.empty();

  @override
  Stream<CameraMoveEvent> onCameraMove({required int mapId}) =>
      const Stream<CameraMoveEvent>.empty();

  @override
  Stream<CameraIdleEvent> onCameraIdle({required int mapId}) =>
      const Stream<CameraIdleEvent>.empty();

  @override
  Stream<MarkerTapEvent> onMarkerTap({required int mapId}) =>
      const Stream<MarkerTapEvent>.empty();

  @override
  Stream<InfoWindowTapEvent> onInfoWindowTap({required int mapId}) =>
      const Stream<InfoWindowTapEvent>.empty();

  @override
  Stream<MarkerDragStartEvent> onMarkerDragStart({required int mapId}) =>
      const Stream<MarkerDragStartEvent>.empty();

  @override
  Stream<MarkerDragEvent> onMarkerDrag({required int mapId}) =>
      const Stream<MarkerDragEvent>.empty();

  @override
  Stream<MarkerDragEndEvent> onMarkerDragEnd({required int mapId}) =>
      const Stream<MarkerDragEndEvent>.empty();

  @override
  Stream<PolylineTapEvent> onPolylineTap({required int mapId}) =>
      const Stream<PolylineTapEvent>.empty();

  @override
  Stream<PolygonTapEvent> onPolygonTap({required int mapId}) =>
      const Stream<PolygonTapEvent>.empty();

  @override
  Stream<CircleTapEvent> onCircleTap({required int mapId}) =>
      const Stream<CircleTapEvent>.empty();

  @override
  Stream<MapTapEvent> onTap({required int mapId}) =>
      const Stream<MapTapEvent>.empty();

  @override
  Stream<MapLongPressEvent> onLongPress({required int mapId}) =>
      const Stream<MapLongPressEvent>.empty();

  @override
  Stream<ClusterTapEvent> onClusterTap({required int mapId}) =>
      const Stream<ClusterTapEvent>.empty();

  @override
  Stream<GroundOverlayTapEvent> onGroundOverlayTap({required int mapId}) =>
      const Stream<GroundOverlayTapEvent>.empty();
}
