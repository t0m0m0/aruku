import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
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
}
