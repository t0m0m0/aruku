import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _StreamLocationService implements LocationService {
  _StreamLocationService(this._controller);
  final StreamController<GeoPoint> _controller;

  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => _controller.stream;
}

void main() {
  group('AppNotifier ナビ中の現在地追従', () {
    test('nav 入場で位置購読し currentPosition を更新する', () async {
      final controller = StreamController<GeoPoint>.broadcast();
      addTearDown(controller.close);
      final container = ProviderContainer(
        overrides: [
          locationServiceProvider.overrideWithValue(
            _StreamLocationService(controller),
          ),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(appStateProvider).currentPosition, isNull);

      notifier.go(Screen.nav);
      controller.add(const GeoPoint(35.0, 139.0));
      await Future<void>.delayed(Duration.zero);

      expect(
        container.read(appStateProvider).currentPosition,
        const GeoPoint(35.0, 139.0),
      );
    });

    test('nav 退場で購読を解除し以降の位置で更新しない', () async {
      final controller = StreamController<GeoPoint>.broadcast();
      addTearDown(controller.close);
      final container = ProviderContainer(
        overrides: [
          locationServiceProvider.overrideWithValue(
            _StreamLocationService(controller),
          ),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(appStateProvider.notifier);
      notifier.go(Screen.nav);
      controller.add(const GeoPoint(35.0, 139.0));
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(appStateProvider).currentPosition,
        const GeoPoint(35.0, 139.0),
      );

      notifier.go(Screen.home);
      controller.add(const GeoPoint(36.0, 140.0));
      await Future<void>.delayed(Duration.zero);

      expect(container.read(appStateProvider).currentPosition, isNull);
    });
  });
}
