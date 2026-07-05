import 'dart:convert';

import 'package:aruku/core/theme/aruku_map_style.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/shared/widgets/aruku_map.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

Widget _host(Widget child) => MaterialApp(
  theme: ArukuTheme.light(),
  home: Scaffold(body: child),
);

void main() {
  group('ArukuMap fallback (useRealMap=false)', () {
    testWidgets('renders stylized CustomPaint, not GoogleMap', (tester) async {
      await tester.pumpWidget(_host(const ArukuMap(useRealMap: false)));
      expect(find.byType(GoogleMap), findsNothing);
      expect(find.byType(CustomPaint), findsWidgets);
    });
  });

  group('ArukuMap real map (useRealMap=true)', () {
    testWidgets('renders GoogleMap', (tester) async {
      await tester.pumpWidget(_host(const ArukuMap(useRealMap: true)));
      expect(find.byType(GoogleMap), findsOneWidget);
    });

    testWidgets('applies Wakaba map style JSON', (tester) async {
      await tester.pumpWidget(_host(const ArukuMap(useRealMap: true)));
      final map = tester.widget<GoogleMap>(find.byType(GoogleMap));
      expect(map.style, arukuWakabaMapStyle);
    });

    testWidgets('full variant uses overview zoom, no tilt', (tester) async {
      await tester.pumpWidget(
        _host(const ArukuMap(useRealMap: true, variant: ArukuMapVariant.full)),
      );
      final cam = tester
          .widget<GoogleMap>(find.byType(GoogleMap))
          .initialCameraPosition;
      expect(cam.zoom, 14);
      expect(cam.tilt, 0);
    });

    testWidgets('nav variant uses close zoom with tilt', (tester) async {
      await tester.pumpWidget(
        _host(const ArukuMap(useRealMap: true, variant: ArukuMapVariant.nav)),
      );
      final cam = tester
          .widget<GoogleMap>(find.byType(GoogleMap))
          .initialCameraPosition;
      expect(cam.zoom, 17);
      expect(cam.tilt, greaterThan(0));
    });

    testWidgets('thumb variant disables gestures', (tester) async {
      await tester.pumpWidget(
        _host(const ArukuMap(useRealMap: true, variant: ArukuMapVariant.thumb)),
      );
      final map = tester.widget<GoogleMap>(find.byType(GoogleMap));
      expect(map.initialCameraPosition.zoom, 13);
      expect(map.zoomGesturesEnabled, isFalse);
      expect(map.scrollGesturesEnabled, isFalse);
      expect(map.rotateGesturesEnabled, isFalse);
      expect(map.tiltGesturesEnabled, isFalse);
    });

    testWidgets('forwards polylines to GoogleMap', (tester) async {
      const polyline = Polyline(
        polylineId: PolylineId('seg0'),
        points: [LatLng(35.0, 139.0), LatLng(35.1, 139.1)],
      );
      await tester.pumpWidget(
        _host(ArukuMap(useRealMap: true, polylines: {polyline})),
      );
      final map = tester.widget<GoogleMap>(find.byType(GoogleMap));
      expect(map.polylines, contains(polyline));
    });

    testWidgets('forwards markers to GoogleMap', (tester) async {
      const marker = Marker(
        markerId: MarkerId('start'),
        position: LatLng(35.6679, 139.7038),
      );
      await tester.pumpWidget(
        _host(ArukuMap(useRealMap: true, markers: {marker})),
      );
      final map = tester.widget<GoogleMap>(find.byType(GoogleMap));
      expect(map.markers, contains(marker));
    });

    testWidgets('defaults to empty polylines and markers', (tester) async {
      await tester.pumpWidget(_host(const ArukuMap(useRealMap: true)));
      final map = tester.widget<GoogleMap>(find.byType(GoogleMap));
      expect(map.polylines, isEmpty);
      expect(map.markers, isEmpty);
    });
  });

  group('shouldAutoFitBounds', () {
    final boundsA = LatLngBounds(
      southwest: const LatLng(35.0, 139.0),
      northeast: const LatLng(35.1, 139.1),
    );
    final boundsB = LatLngBounds(
      southwest: const LatLng(35.2, 139.2),
      northeast: const LatLng(35.3, 139.3),
    );

    test('nav variant は routeBounds が変わっても自動フィットしない（リルート対策）', () {
      expect(
        shouldAutoFitBounds(
          variant: ArukuMapVariant.nav,
          oldBounds: boundsA,
          newBounds: boundsB,
        ),
        isFalse,
      );
    });

    test('full variant は routeBounds が変わると自動フィットする', () {
      expect(
        shouldAutoFitBounds(
          variant: ArukuMapVariant.full,
          oldBounds: boundsA,
          newBounds: boundsB,
        ),
        isTrue,
      );
    });

    test('thumb variant は routeBounds が変わると自動フィットする', () {
      expect(
        shouldAutoFitBounds(
          variant: ArukuMapVariant.thumb,
          oldBounds: boundsA,
          newBounds: boundsB,
        ),
        isTrue,
      );
    });

    test('bounds が変わらなければ variant に関わらず自動フィットしない', () {
      expect(
        shouldAutoFitBounds(
          variant: ArukuMapVariant.full,
          oldBounds: boundsA,
          newBounds: boundsA,
        ),
        isFalse,
      );
    });
  });

  group('Wakaba map style JSON', () {
    test('is a valid, non-empty JSON array', () {
      final decoded = jsonDecode(arukuWakabaMapStyle);
      expect(decoded, isA<List<dynamic>>());
      expect((decoded as List).isNotEmpty, isTrue);
    });
  });
}
