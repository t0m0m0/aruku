import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller, {this.granted = true});

  final StreamController<ActivitySnapshot> _controller;
  final bool granted;
  bool permissionRequested = false;

  @override
  Future<bool> requestPermission() async {
    permissionRequested = true;
    return granted;
  }

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

ProviderContainer _makeContainer(ActivityService activity) {
  return ProviderContainer(
    overrides: [
      activityServiceProvider.overrideWithValue(activity),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
    ],
  );
}

void main() {
  group('AppNotifier + ActivityService 統合', () {
    test('ストリームの値で todaySteps/km/kcal が更新される', () async {
      final controller = StreamController<ActivitySnapshot>();
      final container = _makeContainer(_FakeActivityService(controller));
      addTearDown(container.dispose);
      addTearDown(controller.close);

      container.read(appStateProvider); // build() を起動
      await Future<void>.delayed(Duration.zero); // 権限要求 await を解決

      controller.add(ActivitySnapshot.fromSteps(1000));
      await Future<void>.delayed(Duration.zero);

      final s = container.read(appStateProvider);
      expect(s.todaySteps, 1000);
      expect(s.todayKm, closeTo(0.75, 1e-9));
      expect(s.todayKcal, 43);
    });

    test('権限が拒否されたら購読せず初期値のまま', () async {
      final controller = StreamController<ActivitySnapshot>.broadcast();
      final service = _FakeActivityService(controller, granted: false);
      final container = _makeContainer(service);
      addTearDown(container.dispose);
      addTearDown(controller.close);

      container.read(appStateProvider);
      await Future<void>.delayed(Duration.zero);

      expect(service.permissionRequested, isTrue);
      final s = container.read(appStateProvider);
      expect(s.todaySteps, 0);
      expect(s.todayKm, 0.0);
      expect(s.todayKcal, 0);
    });
  });
}
