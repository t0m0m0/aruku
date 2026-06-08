import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/services/favorites_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<FavoritesRepository> makeRepo() async {
    final prefs = await SharedPreferences.getInstance();
    return FavoritesRepository(prefs);
  }

  FavoritePlace place(String name, {String? placeId}) =>
      FavoritePlace(name: name, placeId: placeId);

  test('保存ゼロ件なら load は空リスト', () async {
    final repo = await makeRepo();
    expect(await repo.load(), isEmpty);
  });

  test('toggle で追加され、新しいものが先頭に来る', () async {
    final repo = await makeRepo();
    await repo.toggle(place('東京駅', placeId: 'p1'));
    await repo.toggle(place('渋谷駅', placeId: 'p2'));
    final list = await repo.load();
    expect(list.map((e) => e.name).toList(), ['渋谷駅', '東京駅']);
  });

  test('同じ地点を再度 toggle すると削除される', () async {
    final repo = await makeRepo();
    await repo.toggle(place('東京駅', placeId: 'p1'));
    expect(await repo.contains(place('東京駅', placeId: 'p1')), isTrue);
    await repo.toggle(place('東京駅', placeId: 'p1'));
    expect(await repo.contains(place('東京駅', placeId: 'p1')), isFalse);
    expect(await repo.load(), isEmpty);
  });

  test('contains は placeId/name の dedupeKey で判定', () async {
    final repo = await makeRepo();
    await repo.toggle(place('カフェ'));
    expect(await repo.contains(place('カフェ')), isTrue);
    expect(await repo.contains(place('公園')), isFalse);
  });

  test('remove で指定地点を削除', () async {
    final repo = await makeRepo();
    await repo.toggle(place('東京駅', placeId: 'p1'));
    await repo.toggle(place('渋谷駅', placeId: 'p2'));
    await repo.remove(place('東京駅', placeId: 'p1'));
    final list = await repo.load();
    expect(list.map((e) => e.name).toList(), ['渋谷駅']);
  });

  test('toggle 時に savedAt が付与される', () async {
    final repo = await makeRepo();
    await repo.toggle(place('東京駅', placeId: 'p1'));
    final list = await repo.load();
    expect(list.single.savedAt, isNotNull);
  });

  test('maxItems を超えると古いものから切り捨て', () async {
    final repo = await makeRepo();
    for (var i = 0; i < FavoritesRepository.maxItems + 5; i++) {
      await repo.toggle(place('地点$i', placeId: 'p$i'));
    }
    final list = await repo.load();
    expect(list.length, FavoritesRepository.maxItems);
    // 直近に追加したものが残る。
    expect(list.first.placeId, 'p${FavoritesRepository.maxItems + 4}');
  });

  test('clear で全削除', () async {
    final repo = await makeRepo();
    await repo.toggle(place('東京駅', placeId: 'p1'));
    await repo.clear();
    expect(await repo.load(), isEmpty);
  });

  test('再起動後も永続化されている', () async {
    final repo = await makeRepo();
    await repo.toggle(place('東京駅', placeId: 'p1'));
    final repo2 = await makeRepo();
    expect(await repo2.contains(place('東京駅', placeId: 'p1')), isTrue);
  });
}
