import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/models/auth_user.dart';
import 'package:aruku/core/models/recent_place.dart';
import 'package:aruku/core/models/sync_data.dart';
import 'package:aruku/core/services/auth_service.dart';
import 'package:aruku/core/services/crash_reporter.dart';
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
  List<RecentPlace> recents = const [],
  List<RecentPlace> recentOrigins = const [],
  AppSettings settings = AppSettings.defaults,
}) => SyncData(
  updatedAt: updatedAt,
  settings: settings,
  recents: recents,
  recentOrigins: recentOrigins,
  activity: const [],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeSyncService sync;

  Future<ProviderContainer> makeContainer({
    AuthUser? user,
    CrashReporter? crashReporter,
    SyncService? syncService,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        syncServiceProvider.overrideWithValue(syncService ?? sync),
        authServiceProvider.overrideWithValue(
          FakeAuthService(initialUser: user),
        ),
        if (crashReporter != null)
          crashReporterProvider.overrideWithValue(crashReporter),
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

  test('crashReporterProvider を fake で上書きできる', () async {
    final reporter = _FakeCrashReporter();
    final container = await makeContainer(crashReporter: reporter);

    expect(container.read(crashReporterProvider), same(reporter));
  });

  test('同期失敗を PII を含まない静的 context で non-fatal 記録する', () async {
    const uid = 'private-user-id';
    const email = 'private@example.com';
    final reporter = _FakeCrashReporter();
    final container = await makeContainer(
      user: const AuthUser(uid: uid, email: email),
      crashReporter: reporter,
      syncService: _ThrowingSyncService(),
    );

    await container.read(syncProvider.notifier).sync();

    expect(container.read(syncProvider).phase, SyncPhase.error);
    expect(reporter.records, hasLength(1));
    final record = reporter.records.single;
    expect(record.error, isA<StateError>());
    expect(record.stack, isNotNull);
    expect(record.context, 'sync.run');
    expect(record.fatal, isFalse);
    expect(record.context, isNot(contains(uid)));
    expect(record.context, isNot(contains(email)));
  });

  test('初回（リモート無し）はローカルをアップロードする', () async {
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final recentsRepo = await container.read(recentsRepositoryProvider.future);
    await recentsRepo.add(const RecentPlace(name: '東京駅', placeId: 'p1'));

    await container.read(syncProvider.notifier).sync();

    expect(container.read(syncProvider).phase, SyncPhase.success);
    expect(sync.store['u1']!.recents.single.name, '東京駅');
  });

  test('リモートが新しければローカルへ取り込む（別端末ログイン）', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2030, 1, 1),
      recents: const [RecentPlace(name: '京都駅', placeId: 'k1')],
      settings: const AppSettings(notificationsEnabled: false),
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );

    await container.read(syncProvider.notifier).sync();

    final recentsRepo = await container.read(recentsRepositoryProvider.future);
    final settingsRepo = await container.read(
      settingsRepositoryProvider.future,
    );
    expect((await recentsRepo.load()).single.name, '京都駅');
    expect(settingsRepo.load().notificationsEnabled, isFalse);
  });

  test('リモートが新しければ出発地履歴もローカルへ取り込む', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2030, 1, 1),
      recentOrigins: const [RecentPlace(name: '自宅', placeId: 'o1')],
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );

    await container.read(syncProvider.notifier).sync();

    final originsRepo = await container.read(
      recentOriginsRepositoryProvider.future,
    );
    expect((await originsRepo.load()).single.name, '自宅');
  });

  test('ローカルが新しければ出発地履歴もリモートへ反映する', () async {
    sync.store['u1'] = remoteSnapshot(updatedAt: DateTime.utc(2000, 1, 1));
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final meta = await container.read(syncMetaRepositoryProvider.future);
    await meta.markLocalChanged(DateTime.utc(2030, 1, 1));
    final originsRepo = await container.read(
      recentOriginsRepositoryProvider.future,
    );
    await originsRepo.add(const RecentPlace(name: '職場', placeId: 'o2'));

    await container.read(syncProvider.notifier).sync();

    expect(sync.store['u1']!.recentOrigins.single.name, '職場');
  });

  test('ローカルが新しければリモートを上書きする', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2000, 1, 1),
      recents: const [RecentPlace(name: '古い', placeId: 'old')],
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final meta = await container.read(syncMetaRepositoryProvider.future);
    await meta.markLocalChanged(DateTime.utc(2030, 1, 1));
    final recentsRepo = await container.read(recentsRepositoryProvider.future);
    await recentsRepo.add(const RecentPlace(name: '新しい', placeId: 'new'));

    await container.read(syncProvider.notifier).sync();

    expect(sync.store['u1']!.recents.single.name, '新しい');
    expect(sync.pushCount, 1);
  });

  test('リモートが勝った場合は取り込んだ内容を押し戻さない', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2030, 1, 1),
      recents: const [RecentPlace(name: '京都駅', placeId: 'k1')],
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );

    await container.read(syncProvider.notifier).sync();

    // fetch した remote をそのまま push し直すのは無駄な書き込みなので行わない。
    expect(sync.pushCount, 0);
    expect(container.read(syncProvider).phase, SyncPhase.success);
    expect(container.read(syncProvider).lastSyncedAt, isNotNull);
  });

  test('変更が無ければ push しない（無駄な Firestore 書き込みを避ける）', () async {
    // ローカルとリモートが（更新時刻を含め）同一なら書き込むものが無い。
    final at = DateTime.utc(2030, 1, 1);
    sync.store['u1'] = remoteSnapshot(updatedAt: at);
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final meta = await container.read(syncMetaRepositoryProvider.future);
    await meta.markLocalChanged(at);

    await container.read(syncProvider.notifier).sync();

    expect(sync.pushCount, 0);
    expect(container.read(syncProvider).phase, SyncPhase.success);
  });

  test('push 後の再同期は往復しても no-op（pushCount が増えない）', () async {
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    final recentsRepo = await container.read(recentsRepositoryProvider.future);
    await recentsRepo.add(const RecentPlace(name: '東京駅', placeId: 'p1'));

    // 初回はリモートが空なのでアップロードする。
    await container.read(syncProvider.notifier).sync();
    expect(sync.pushCount, 1);

    // 変更していないので 2 回目はリポジトリ往復を経ても書き込まない。
    await container.read(syncProvider.notifier).sync();
    expect(sync.pushCount, 1);
  });

  test('リモート取り込み後の再同期も往復して no-op', () async {
    sync.store['u1'] = remoteSnapshot(
      updatedAt: DateTime.utc(2030, 1, 1),
      recents: const [RecentPlace(name: '京都駅', placeId: 'k1')],
    );
    final container = await makeContainer(
      user: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );

    // リモートが勝つので取り込むが押し戻さない。
    await container.read(syncProvider.notifier).sync();
    expect(sync.pushCount, 0);

    // 取り込んだ内容をローカルから再ロードしても内容一致で書き込まない。
    await container.read(syncProvider.notifier).sync();
    expect(sync.pushCount, 0);
  });
}

class _ThrowingSyncService implements SyncService {
  @override
  Future<SyncData?> fetch(String uid) => throw StateError('sync unavailable');

  @override
  Future<void> push(String uid, SyncData data) async {}
}

class _FakeCrashReporter implements CrashReporter {
  final List<_RecordedError> records = [];

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    bool fatal = false,
  }) async {
    records.add(
      _RecordedError(
        error: error,
        stack: stack,
        context: context,
        fatal: fatal,
      ),
    );
  }
}

class _RecordedError {
  const _RecordedError({
    required this.error,
    required this.stack,
    required this.context,
    required this.fatal,
  });

  final Object error;
  final StackTrace? stack;
  final String? context;
  final bool fatal;
}
