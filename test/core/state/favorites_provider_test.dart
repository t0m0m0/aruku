import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/services/favorites_repository.dart';
import 'package:aruku/core/state/favorites_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

ProviderContainer _container() {
  final container = ProviderContainer();
  addTearDown(container.dispose);
  return container;
}

Future<void> _waitUntilData(ProviderContainer container) async {
  while (container.read(favoritesProvider) is AsyncLoading) {
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
    await FavoritesRepository(
      prefs,
    ).toggle(const FavoritePlace(name: '東京駅', placeId: 'p1'));

    final container = _container();
    await _waitUntilData(container);
    final list = container.read(favoritesProvider).value!;
    expect(list.map((e) => e.placeId), ['p1']);
  });

  test('toggle で追加・削除され state が更新される', () async {
    final container = _container();
    await _waitUntilData(container);
    const place = FavoritePlace(name: '渋谷駅', placeId: 'p2');

    await container.read(favoritesProvider.notifier).toggle(place);
    expect(container.read(favoritesProvider).value!.first.placeId, 'p2');

    await container.read(favoritesProvider.notifier).toggle(place);
    expect(container.read(favoritesProvider).value, isEmpty);
  });

  test('isFavorite で登録状態を判定できる', () async {
    final container = _container();
    await _waitUntilData(container);
    const place = FavoritePlace(name: '東京駅', placeId: 'p1');

    expect(container.read(favoritesProvider.notifier).isFavorite(place), false);
    await container.read(favoritesProvider.notifier).toggle(place);
    expect(container.read(favoritesProvider.notifier).isFavorite(place), true);
  });
}
