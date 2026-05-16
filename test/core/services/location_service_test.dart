import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeLocationService implements LocationService {
  _FakeLocationService(this._result);
  final LocationState _result;

  @override
  Future<LocationState> request() async => _result;
}

ProviderContainer _makeContainer(LocationService service) {
  return ProviderContainer(
    overrides: [locationServiceProvider.overrideWithValue(service)],
  );
}

void main() {
  group('AppNotifier + LocationService 統合', () {
    test('Available が返ったとき locationState が更新される', () async {
      const pos = GeoPoint(35.68, 139.76);
      final container = _makeContainer(
        _FakeLocationService(const LocationAvailable(pos)),
      );
      addTearDown(container.dispose);

      // build() 直後は Loading
      final initial = container.read(appStateProvider);
      expect(initial.locationState, isA<LocationLoading>());

      // 非同期処理が完了するまで待つ
      await Future<void>.delayed(Duration.zero);

      final updated = container.read(appStateProvider);
      expect(updated.locationState, isA<LocationAvailable>());
      expect((updated.locationState as LocationAvailable).position, pos);
    });

    test('Denied が返ったとき locationState が LocationDenied になる', () async {
      final container = _makeContainer(
        _FakeLocationService(const LocationDenied()),
      );
      addTearDown(container.dispose);

      container.read(appStateProvider); // プロバイダーを初期化して _fetchLocation を開始
      await Future<void>.delayed(Duration.zero);

      final updated = container.read(appStateProvider);
      expect(updated.locationState, isA<LocationDenied>());
    });
  });
}
