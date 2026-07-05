import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/config/app_config.dart';
import '../../core/theme/aruku_map_style.dart';
import '../../core/theme/aruku_theme.dart';

/// Map widget — uses google_maps_flutter when [useRealMap] is true,
/// otherwise renders a stylized SVG-like placeholder matching the design.
class ArukuMap extends StatefulWidget {
  const ArukuMap({
    super.key,
    this.variant = ArukuMapVariant.full,
    this.showRoute = true,
    this.useRealMap = AppConfig.useRealMap,
    this.polylines = const {},
    this.markers = const {},
    this.routeBounds,
    this.mapType = MapType.normal,
    this.onMapReady,
    this.onFitBoundsComplete,
  });

  final ArukuMapVariant variant;
  final bool showRoute;

  /// 既定は [AppConfig.useRealMap]（`--dart-define=USE_REAL_MAP=true` で true）。
  /// false のときは非インタラクティブなスタイライズド地図を描画する。
  final bool useRealMap;

  final Set<Polyline> polylines;
  final Set<Marker> markers;
  final LatLngBounds? routeBounds;

  /// 地図の表示種別（通常/航空写真など）。レイヤー切替に用いる。
  final MapType mapType;

  /// 実地図のコントローラ準備完了時に呼ばれる（カメラ操作用）。
  final void Function(GoogleMapController controller)? onMapReady;

  /// ルート全体俯瞰への `_fitBounds` 完了時に呼ばれる（ナビ視点への切り替え用）。
  final void Function(GoogleMapController controller)? onFitBoundsComplete;

  /// 渋谷駅付近（デザインの基準エリア）。[routeBounds] 未指定時の初期位置。
  static const LatLng _defaultTarget = LatLng(35.6679, 139.7038);

  @override
  State<ArukuMap> createState() => _ArukuMapState();
}

/// `didUpdateWidget` で自動 `_fitBounds` を実行すべきか判定する。
///
/// nav variant はリルート成功時の `route` 差し替え（＝routeBounds 変化）でも
/// ルート全体俯瞰へカメラが戻らないよう、自動フィットを行わない。
/// 初回表示時のフィット（[_ArukuMapState._onMapCreated]）は対象外。
@visibleForTesting
bool shouldAutoFitBounds({
  required ArukuMapVariant variant,
  required LatLngBounds? oldBounds,
  required LatLngBounds? newBounds,
}) {
  if (variant == ArukuMapVariant.nav) return false;
  return oldBounds != newBounds;
}

class _ArukuMapState extends State<ArukuMap> {
  GoogleMapController? _controller;

  Future<void> _onMapCreated(GoogleMapController controller) async {
    _controller = controller;
    widget.onMapReady?.call(controller);
    await _fitBounds();
  }

  Future<void> _fitBounds() async {
    final bounds = widget.routeBounds;
    if (bounds == null || _controller == null) return;
    final padding = widget.variant == ArukuMapVariant.thumb ? 16.0 : 48.0;
    await _controller!.animateCamera(
      CameraUpdate.newLatLngBounds(bounds, padding),
    );
    if (!mounted) return;
    widget.onFitBoundsComplete?.call(_controller!);
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ArukuMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (shouldAutoFitBounds(
      variant: widget.variant,
      oldBounds: oldWidget.routeBounds,
      newBounds: widget.routeBounds,
    )) {
      _fitBounds();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.useRealMap) {
      final interactive = widget.variant != ArukuMapVariant.thumb;
      return GoogleMap(
        initialCameraPosition: CameraPosition(
          target: ArukuMap._defaultTarget,
          zoom: widget.variant.zoom,
          tilt: widget.variant.tilt,
        ),
        style: arukuWakabaMapStyle,
        mapType: widget.mapType,
        myLocationButtonEnabled: false,
        zoomControlsEnabled: false,
        mapToolbarEnabled: false,
        compassEnabled: widget.variant == ArukuMapVariant.nav,
        zoomGesturesEnabled: interactive,
        scrollGesturesEnabled: interactive,
        rotateGesturesEnabled: interactive,
        tiltGesturesEnabled: interactive,
        polylines: widget.polylines,
        markers: widget.markers,
        onMapCreated: _onMapCreated,
      );
    }
    return CustomPaint(
      size: Size.infinite,
      painter: _StylizedMapPainter(
        context,
        variant: widget.variant,
        showRoute: widget.showRoute,
      ),
    );
  }
}

enum ArukuMapVariant {
  /// 全体表示（result / loading）。俯瞰ズーム。
  full,

  /// ナビ視点。寄りズーム＋傾き。
  nav,

  /// チップサイズのサムネイル。非インタラクティブ。
  thumb;

  double get zoom => switch (this) {
    ArukuMapVariant.full => 14,
    ArukuMapVariant.nav => 17,
    ArukuMapVariant.thumb => 13,
  };

  double get tilt => this == ArukuMapVariant.nav ? 45 : 0;
}

class _StylizedMapPainter extends CustomPainter {
  _StylizedMapPainter(
    BuildContext ctx, {
    required this.variant,
    required this.showRoute,
  }) : c = ctx.c;

  final dynamic c; // ArukuColors via dynamic to avoid Painter→context cycle
  final ArukuMapVariant variant;
  final bool showRoute;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = c.mapBg);

    // Park blobs
    final parkPaint = Paint()..color = c.mapPark;
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(size.width * 0.2, size.height * 0.3),
        width: size.width * 0.55,
        height: size.height * 0.32,
      ),
      parkPaint,
    );
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(size.width * 0.78, size.height * 0.72),
        width: size.width * 0.5,
        height: size.height * 0.3,
      ),
      parkPaint,
    );

    // Water
    canvas.drawRect(
      Rect.fromLTWH(0, size.height * 0.82, size.width, size.height * 0.18),
      Paint()..color = c.mapWater,
    );

    // Major roads
    final majorPaint = Paint()
      ..color = c.mapMajor
      ..strokeWidth = variant == ArukuMapVariant.thumb ? 5 : 10
      ..style = PaintingStyle.stroke;
    canvas.drawLine(
      Offset(0, size.height * 0.45),
      Offset(size.width, size.height * 0.55),
      majorPaint,
    );
    canvas.drawLine(
      Offset(size.width * 0.6, 0),
      Offset(size.width * 0.5, size.height),
      majorPaint,
    );

    // Minor roads
    final roadPaint = Paint()
      ..color = c.mapRoad
      ..strokeWidth = variant == ArukuMapVariant.thumb ? 2.5 : 5
      ..style = PaintingStyle.stroke;
    for (int i = 1; i <= 5; i++) {
      canvas.drawLine(
        Offset(0, size.height * (0.15 * i)),
        Offset(size.width, size.height * (0.15 * i + 0.05)),
        roadPaint,
      );
      canvas.drawLine(
        Offset(size.width * 0.2 * i, 0),
        Offset(size.width * (0.2 * i - 0.05), size.height),
        roadPaint,
      );
    }

    // Buildings
    final buildPaint = Paint()..color = c.mapBuild;
    final rand = [0.18, 0.32, 0.58, 0.74, 0.88];
    for (final r in rand) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: Offset(size.width * r, size.height * (0.2 + r * 0.5)),
            width: 26,
            height: 22,
          ),
          const Radius.circular(3),
        ),
        buildPaint,
      );
    }

    if (showRoute) {
      _drawRoute(canvas, size);
    }
  }

  void _drawRoute(Canvas canvas, Size size) {
    final walkPaint = Paint()
      ..color = c.moss500
      ..strokeWidth = variant == ArukuMapVariant.thumb ? 2.5 : 5
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    final trainPaint = Paint()
      ..color = c.train
      ..strokeWidth = variant == ArukuMapVariant.thumb ? 3 : 6
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    // Train segment in middle (solid)
    canvas.drawLine(
      Offset(size.width * 0.35, size.height * 0.5),
      Offset(size.width * 0.6, size.height * 0.55),
      trainPaint,
    );

    // Walk segments (dashed)
    _drawDashed(
      canvas,
      Offset(size.width * 0.12, size.height * 0.18),
      Offset(size.width * 0.35, size.height * 0.5),
      walkPaint,
    );
    _drawDashed(
      canvas,
      Offset(size.width * 0.6, size.height * 0.55),
      Offset(size.width * 0.85, size.height * 0.85),
      walkPaint,
    );

    // Start pin (white + moss500 + white)
    final start = Offset(size.width * 0.12, size.height * 0.18);
    canvas.drawCircle(
      start,
      variant == ArukuMapVariant.thumb ? 5 : 11,
      Paint()..color = Colors.white,
    );
    canvas.drawCircle(
      start,
      variant == ArukuMapVariant.thumb ? 3.5 : 7,
      Paint()..color = c.moss500,
    );
    canvas.drawCircle(
      start,
      variant == ArukuMapVariant.thumb ? 1.5 : 3,
      Paint()..color = Colors.white,
    );

    // End pin (droplet — burnt)
    final end = Offset(size.width * 0.85, size.height * 0.85);
    final droplet = Path()
      ..moveTo(end.dx, end.dy + 8)
      ..cubicTo(
        end.dx - 9,
        end.dy - 4,
        end.dx - 9,
        end.dy - 8,
        end.dx,
        end.dy - 12,
      )
      ..cubicTo(
        end.dx + 9,
        end.dy - 8,
        end.dx + 9,
        end.dy - 4,
        end.dx,
        end.dy + 8,
      )
      ..close();
    canvas.drawPath(droplet, Paint()..color = c.burnt);
    canvas.drawPath(
      droplet,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  void _drawDashed(Canvas canvas, Offset a, Offset b, Paint p) {
    const dash = 6.0;
    const gap = 4.0;
    final dx = b.dx - a.dx, dy = b.dy - a.dy;
    final dist = (dx * dx + dy * dy).abs();
    if (dist == 0) return;
    final len = (dist.toDouble()).clamp(1.0, 1e9);
    final norm = Offset(
      dx / (len > 0 ? Offset(dx, dy).distance : 1),
      dy / (len > 0 ? Offset(dx, dy).distance : 1),
    );
    final total = Offset(dx, dy).distance;
    double drawn = 0;
    while (drawn < total) {
      final start = a + norm * drawn;
      final end = a + norm * (drawn + dash).clamp(0, total).toDouble();
      canvas.drawLine(start, end, p);
      drawn += dash + gap;
    }
  }

  @override
  bool shouldRepaint(_StylizedMapPainter old) =>
      old.variant != variant || old.showRoute != showRoute;
}
