import 'package:aruku/features/navigation/nav_marker_icon.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('進行方向つきの現在地アイコンを生成できる', () async {
    final icon = await buildDirectionalMarkerIcon(color: Colors.blue);

    expect(icon, isA<BitmapDescriptor>());
  });
}
