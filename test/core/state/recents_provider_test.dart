import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/recent_place.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/state/recents_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

ProviderContainer _container() {
  final container = ProviderContainer();
  addTearDown(container.dispose);
  return container;
}

Future<void> _waitUntilData(ProviderContainer container) async {
  while (container.read(recentsProvider) is AsyncLoading) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('初期状態は repository の内容をロードする', () async {
    final prefs = await SharedPreferences.getInstance();
    await RecentsRepository(
      prefs,
    ).add(const RecentPlace(name: '東京駅', placeId: 'p1'));

    final container = _container();
    await _waitUntilData(container);
    final list = container.read(recentsProvider).value!;
    expect(list.map((e) => e.placeId), ['p1']);
  });

  test('add で state が更新される', () async {
    final container = _container();
    await _waitUntilData(container);

    await container
        .read(recentsProvider.notifier)
        .add(
          const RecentPlace(
            name: '渋谷駅',
            placeId: 'p2',
            latLng: GeoPoint(35.658, 139.701),
          ),
        );

    final list = container.read(recentsProvider).value!;
    expect(list.first.placeId, 'p2');
  });

  test('clear で空になる', () async {
    final container = _container();
    await _waitUntilData(container);
    await container
        .read(recentsProvider.notifier)
        .add(const RecentPlace(name: '東京駅', placeId: 'p1'));
    await container.read(recentsProvider.notifier).clear();
    expect(container.read(recentsProvider).value, isEmpty);
  });
}
