import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/models/auth_user.dart';
import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/models/sync_data.dart';
import 'package:aruku/core/services/auth_service.dart';
import 'package:aruku/core/services/favorites_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/services/sync_meta_repository.dart';
import 'package:aruku/core/services/sync_service.dart';
import 'package:aruku/core/state/auth_provider.dart';
import 'package:aruku/core/state/sync_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/fake_auth_service.dart';
import '../../support/fake_sync_service.dart';

SyncData remoteSnapshot({
  required DateTime updatedAt,
  List<FavoritePlace> favorites = const [],
  AppSettings settings = AppSettings.defaults,
}) => SyncData(
  updatedAt: updatedAt,
  settings: settings,
  favorites: favorites,
  recents: const [],
  activity: const [],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeSyncService sync;

  Future<ProviderContainer> makeContainer({AuthUser? user}) async {
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        syncServiceProvider.overrideWithValue(sync),
        authServiceProvider.overrideWithValue(
          FakeAuthService(initialUser: user),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authProvider.future);
    return container;
  }

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    sync = FakeSyncService();
  });

  test('未ログインでは何もしない', () async {
    final container = await makeContainer();
    await container.read(syncProvider.notifier).sync();

    expect(sync.pushCount, 0);
    expect(container.read(syncProvider).phase, SyncPhase.idle);
  });

  test('初回（リモート無し）はローカルをアップロードする', () async {
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final favRepo = await container.read(favoritesRepositoryProvider.future);
    await favRepo.toggle(const FavoritePlace(name: '東京駅', placeId: 'p1'));

    await container.read(syncProvider.notifier).sync();

    expect(container.read(syncProvider).phase, SyncPhase.success);
    expect(sync.store['u1']!.favorites.single.name, '東京駅');
  });

  test('リモートが新しければローカルへ取り込む（別端末ログイン）', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2030, 1, 1),
      favorites: const [FavoritePlace(name: '京都駅', placeId: 'k1')],
      settings: const AppSettings(notificationsEnabled: false),
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );

    await container.read(syncProvider.notifier).sync();

    final favRepo = await container.read(favoritesRepositoryProvider.future);
    final settingsRepo = await container.read(
      settingsRepositoryProvider.future,
    );
    expect((await favRepo.load()).single.name, '京都駅');
    expect(settingsRepo.load().notificationsEnabled, isFalse);
  });

  test('ローカルが新しければリモートを上書きする', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2000, 1, 1),
      favorites: const [FavoritePlace(name: '古い', placeId: 'old')],
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final meta = await container.read(syncMetaRepositoryProvider.future);
    await meta.markLocalChanged(DateTime.utc(2030, 1, 1));
    final favRepo = await container.read(favoritesRepositoryProvider.future);
    await favRepo.toggle(const FavoritePlace(name: '新しい', placeId: 'new'));

    await container.read(syncProvider.notifier).sync();

    expect(sync.store['u1']!.favorites.single.name, '新しい');
  });
}
