import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

/// 現在地マーカー用、進行方向（矢印）付きアイコンを描画して生成する。
/// [Marker.rotation] と組み合わせて使うため、アイコン自体は常に真上を指す
/// 矢印として描く。
Future<BitmapDescriptor> buildDirectionalMarkerIcon({
  required Color color,
  double size = 96,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  final center = Offset(size / 2, size / 2);
  final radius = size / 2;

  final bodyPaint = Paint()..color = color;
  canvas.drawCircle(center, radius * 0.62, bodyPaint);

  final ringPaint = Paint()
    ..color = Colors.white
    ..style = PaintingStyle.stroke
    ..strokeWidth = size * 0.06;
  canvas.drawCircle(center, radius * 0.62, ringPaint);

  final arrowPaint = Paint()..color = Colors.white;
  final arrow = Path()
    ..moveTo(center.dx, center.dy - radius * 0.5)
    ..lineTo(center.dx - radius * 0.28, center.dy + radius * 0.15)
    ..lineTo(center.dx + radius * 0.28, center.dy + radius * 0.15)
    ..close();
  canvas.drawPath(arrow, arrowPaint);

  final picture = recorder.endRecording();
  final image = await picture.toImage(size.toInt(), size.toInt());
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return BitmapDescriptor.bytes(bytes!.buffer.asUint8List());
}
