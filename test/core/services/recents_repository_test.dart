import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/recent_place.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<RecentsRepository> makeRepo() async {
    final prefs = await SharedPreferences.getInstance();
    return RecentsRepository(prefs);
  }

  Future<RecentsRepository> makeOriginsRepo() async {
    final prefs = await SharedPreferences.getInstance();
    return RecentsRepository(prefs, key: RecentsRepository.originsKey);
  }

  RecentPlace dest(
    String name, {
    String? placeId,
    GeoPoint? latLng,
    DateTime? usedAt,
  }) {
    return RecentPlace(
      name: name,
      placeId: placeId,
      latLng: latLng,
      usedAt: usedAt,
    );
  }

  test('保存ゼロ件なら load は空リスト', () async {
    final repo = await makeRepo();
    expect(await repo.load(), isEmpty);
  });

  test('add したものが load で先頭から取り出せる', () async {
    final repo = await makeRepo();
    await repo.add(dest('東京駅', placeId: 'p1'));
    await repo.add(dest('渋谷駅', placeId: 'p2'));
    final list = await repo.load();
    expect(list.map((e) => e.name).toList(), ['渋谷駅', '東京駅']);
  });

  test('同じ placeId は重複排除され、最新が先頭に来る', () async {
    final repo = await makeRepo();
    await repo.add(dest('東京駅', placeId: 'p1'));
    await repo.add(dest('渋谷駅', placeId: 'p2'));
    await repo.add(dest('東京駅', placeId: 'p1'));
    final list = await repo.load();
    expect(list.map((e) => e.placeId).toList(), ['p1', 'p2']);
  });

  test('placeId が無い場合は name で重複排除', () async {
    final repo = await makeRepo();
    await repo.add(dest('カフェ'));
    await repo.add(dest('公園'));
    await repo.add(dest('カフェ'));
    final list = await repo.load();
    expect(list.map((e) => e.name).toList(), ['カフェ', '公園']);
  });

  test('最大件数を超えると古いものから捨てる', () async {
    final repo = await makeRepo();
    for (var i = 0; i < RecentsRepository.maxItems + 3; i++) {
      await repo.add(dest('place_$i', placeId: 'id_$i'));
    }
    final list = await repo.load();
    expect(list.length, RecentsRepository.maxItems);
    expect(list.first.placeId, 'id_${RecentsRepository.maxItems + 2}');
  });

  test('clear で空になる', () async {
    final repo = await makeRepo();
    await repo.add(dest('東京駅', placeId: 'p1'));
    await repo.clear();
    expect(await repo.load(), isEmpty);
  });

  test('出発地用キーは目的地履歴と混ざらず独立して保存される', () async {
    final destinations = await makeRepo();
    final origins = await makeOriginsRepo();

    await destinations.add(dest('東京駅', placeId: 'd1'));
    await origins.add(dest('自宅', placeId: 'o1'));

    expect((await destinations.load()).map((e) => e.name).toList(), ['東京駅']);
    expect((await origins.load()).map((e) => e.name).toList(), ['自宅']);
  });

  test('出発地リポジトリは destinations キーを書き換えない', () async {
    final destinations = await makeRepo();
    final origins = await makeOriginsRepo();

    await destinations.add(dest('東京駅', placeId: 'd1'));
    await origins.clear();

    expect((await destinations.load()).map((e) => e.name).toList(), ['東京駅']);
  });

  test('並行 add でも書き込みが失われず全件保存される', () async {
    final repo = await makeRepo();
    await Future.wait([
      for (var i = 0; i < 5; i++) repo.add(dest('place_$i', placeId: 'id_$i')),
    ]);
    final list = await repo.load();
    expect(list.length, 5);
    expect(list.map((e) => e.placeId).toSet(), {
      'id_0',
      'id_1',
      'id_2',
      'id_3',
      'id_4',
    });
  });
}
