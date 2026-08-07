import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/crash_reporter.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late StreamController<ActivitySnapshot> controller;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    controller = StreamController<ActivitySnapshot>();
  });

  tearDown(() => controller.close());

  Future<ActivityLogRepository> seedRepo(List<DailyActivity> entries) async {
    final prefs = await SharedPreferences.getInstance();
    final repo = ActivityLogRepository(prefs);
    for (final e in entries) {
      await repo.upsert(e);
    }
    return repo;
  }

  ProviderContainer makeContainer(ActivityLogRepository repo) {
    final container = ProviderContainer(
      overrides: [
        activityLogRepositoryProvider.overrideWith((ref) async => repo),
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  DateTime daysAgo(int n) {
    final t = DateTime.now();
    return DateTime(t.year, t.month, t.day).subtract(Duration(days: n));
  }

  test('起動時に履歴から連続日数が算出される', () async {
    final repo = await seedRepo([
      DailyActivity(date: daysAgo(2), steps: 1000),
      DailyActivity(date: daysAgo(1), steps: 1000),
      DailyActivity(date: daysAgo(0), steps: 1000),
    ]);
    final container = makeContainer(repo);

    container.read(appStateProvider);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(container.read(appStateProvider).streakDays, 3);
  });

  test('起動時に今日の歩数と週次距離が履歴から反映される', () async {
    final repo = await seedRepo([DailyActivity(date: daysAgo(0), steps: 2000)]);
    final container = makeContainer(repo);

    container.read(appStateProvider);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    final state = container.read(appStateProvider);
    expect(state.todaySteps, 2000);
    // 今日は必ず今週に含まれるため週次距離は今日の距離以上。
    expect(state.weekKm, closeTo(ActivitySnapshot.fromSteps(2000).km, 1e-9));
  });

  test('セッション歩数が今日の既存歩数へ加算され永続化される', () async {
    final repo = await seedRepo([DailyActivity(date: daysAgo(0), steps: 1000)]);
    final container = makeContainer(repo);

    container.read(appStateProvider);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    controller.add(ActivitySnapshot.fromSteps(500));
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(container.read(appStateProvider).todaySteps, 1500);

    final persisted = await repo.load();
    final today = persisted.firstWhere((e) => e.steps == 1500);
    expect(today.steps, 1500);
  });

  test('破棄後に活動履歴の保存が失敗しても取得済み reporter へ記録する', () async {
    final prefs = await SharedPreferences.getInstance();
    final repo = _DelayedFailingActivityLogRepository(prefs);
    final reporter = _FakeCrashReporter();
    final container = ProviderContainer(
      overrides: [
        activityLogRepositoryProvider.overrideWith((ref) async => repo),
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        crashReporterProvider.overrideWithValue(reporter),
      ],
    );

    container.read(appStateProvider);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    controller.add(ActivitySnapshot.fromSteps(500));
    await repo.upsertStarted.future;

    container.dispose();
    repo.upsertResult.completeError(
      StateError('persist unavailable'),
      StackTrace.current,
    );
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(reporter.contexts, ['activity.persist']);
  });

  test('履歴ロード完了前に届いたセッション歩数も基準歩数へ正しく加算される', () async {
    final repo = await seedRepo([DailyActivity(date: daysAgo(0), steps: 1000)]);
    // 履歴ロードの完了をテスト側のゲートで握り、「購読確立後・ロード完了前に計測が
    // 届く」順序を時間ではなく制御フローで固定する。
    // なぜ時間で遅延させないか: 負荷次第でロードが先に完了し、保留バッファを通らない
    // まま同じ期待値(1500)で緑になる＝検証対象の経路を静かに素通りするため。
    final historyLoadGate = Completer<void>();
    final container = ProviderContainer(
      overrides: [
        activityLogRepositoryProvider.overrideWith((ref) async {
          await historyLoadGate.future;
          return repo;
        }),
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
      ],
    );
    addTearDown(container.dispose);

    container.read(appStateProvider);
    // 購読は確立済み、履歴ロードはゲート待ちで未完了。
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    // ロード完了前にセッション歩数が届く（保留バッファへ退避されるはず）。
    controller.add(ActivitySnapshot.fromSteps(500));
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    // 基準歩数の確定前は反映しない。ここが 500 なら保留せず即時反映しており、
    // 最終値が偶然一致しても仕様を満たしていない。
    expect(container.read(appStateProvider).todaySteps, 0);

    // ここで初めてロードを完了させる。基準歩数(1000)へ加算される（500 で上書きしない）。
    historyLoadGate.complete();
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(container.read(appStateProvider).todaySteps, 1500);
  });
}

class _DelayedFailingActivityLogRepository extends ActivityLogRepository {
  _DelayedFailingActivityLogRepository(super.prefs);

  final Completer<void> upsertStarted = Completer<void>();
  final Completer<void> upsertResult = Completer<void>();

  @override
  Future<void> upsert(DailyActivity entry, {DateTime? now}) {
    upsertStarted.complete();
    return upsertResult.future;
  }
}

class _FakeCrashReporter implements CrashReporter {
  final List<String?> contexts = [];

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    bool fatal = false,
  }) async {
    contexts.add(context);
  }
}
