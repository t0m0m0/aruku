import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const HomeScreen()),
);

void main() {
  testWidgets('計測した歩数がサマリーに表示される', (tester) async {
    final controller = StreamController<ActivitySnapshot>();
    final container = ProviderContainer(
      overrides: [
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(controller.close);

    container.read(appStateProvider); // build() を起動
    await tester.pumpWidget(_wrap(container));

    await tester.runAsync(() async {
      // 権限要求の await を解決して購読を確立し、歩数を流す。
      await Future<void>.delayed(Duration.zero);
      controller.add(ActivitySnapshot.fromSteps(2000));
      await Future<void>.delayed(Duration.zero);
    });
    await tester.pump();

    expect(find.text('今日の歩数'), findsOneWidget);
    expect(find.text('2000'), findsOneWidget);
    expect(find.text('歩'), findsOneWidget);
  });
}
