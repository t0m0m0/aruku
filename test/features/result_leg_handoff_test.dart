import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/services/url_launcher.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FixedRouteService implements RouteService {
  _FixedRouteService(this.result);
  final RoutePlan result;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
    CancellationToken? cancellation,
  }) async => result;
}

/// 現在地なし（LocationDenied）を返す既定のフェイク。origin 省略の既定条件を
/// 固定するため、位置が必要なテストのみ別途上書きする。
class _FakeLocationService implements LocationService {
  const _FakeLocationService([this.result = const LocationDenied()]);
  final LocationState result;

  @override
  Future<LocationState> request() async => result;

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
}

// 蒲田→(徒歩)→新橋駅→(電車)→東京駅→(徒歩)→東京タワー の3区間プラン。
// 区間ごとの引き継ぎ先が全行程の終点（東京タワー）に固定されないことを
// 確認するための固定経路。
const _shimbashiPos = GeoPoint(35.6665, 139.7580);
const _tokyoPos = GeoPoint(35.6812, 139.7671);
const _tokyoTowerPos = GeoPoint(35.6586, 139.7454);

const _walkToShimbashi = RouteSegment(
  type: SegmentType.walk,
  fromName: '蒲田',
  toName: '新橋駅',
  km: 1.5,
  minutes: 20,
  kcal: 80,
  polyline: [GeoPoint(35.5614, 139.7161), _shimbashiPos],
);

const _trainToTokyo = RouteSegment(
  type: SegmentType.train,
  fromName: '新橋',
  toName: '東京駅',
  minutes: 3,
  line: 'JR山手線',
  polyline: [_shimbashiPos, _tokyoPos],
);

const _walkToTokyoTower = RouteSegment(
  type: SegmentType.walk,
  fromName: '東京駅',
  toName: '東京タワー',
  km: 2.0,
  minutes: 25,
  kcal: 100,
  polyline: [_tokyoPos, _tokyoTowerPos],
);

const _threeLegRoute = RoutePlan(
  from: '蒲田',
  to: '東京タワー',
  totalKm: 5.0,
  totalMin: 48,
  budgetMin: 90,
  kcal: 180,
  walkKm: 3.5,
  walkRatio: 0.7,
  segments: [_walkToShimbashi, _trainToTokyo, _walkToTokyoTower],
  timelineNodes: [
    TimelineNode(time: '9:00', place: '蒲田', sub: '出発'),
    TimelineNode(time: '9:20', place: '新橋駅', sub: 'JR山手線 内回り'),
    TimelineNode(time: '9:23', place: '東京駅', sub: '徒歩へ'),
    TimelineNode(time: '9:48', place: '東京タワー', sub: '到着'),
  ],
);

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const ResultScreen(),
  ),
);

/// 可変の現在時刻。`now` を [nowProvider] へ渡し、`value` を書き換えて時間を進める。
class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}

ProviderContainer _containerFor({
  RoutePlan plan = _threeLegRoute,
  LocationState locationState = const LocationDenied(),
  DateTime Function()? now,
  required Future<bool> Function(Uri url) launcher,
}) {
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(
        _FakeLocationService(locationState),
      ),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
      urlLauncherProvider.overrideWithValue(launcher),
      if (now != null) nowProvider.overrideWithValue(now),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('初期表示で現在区間（index0・徒歩）のCTAが表示され、旧CTAは表示されない', (tester) async {
    final container = _containerFor(launcher: (_) async => true);
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('Google Mapsで新橋駅まで歩く'), findsOneWidget);
    expect(find.text('このルートで歩く'), findsNothing);
  });

  testWidgets('CTAタップで journey が開始され、区間終点(新橋)へのURLが起動される', (tester) async {
    final launched = <Uri>[];
    final container = _containerFor(
      launcher: (url) async {
        launched.add(url);
        return true;
      },
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(container.read(appStateProvider).journey, isNotNull);
    expect(container.read(appStateProvider).journey!.currentLegIndex, 0);
    expect(launched, hasLength(1));
    final uri = launched.single;
    expect(uri.queryParameters['destination'], '35.6665,139.758');
    expect(uri.queryParameters['travelmode'], 'walking');
    expect(uri.queryParameters['dir_action'], 'navigate');
    expect(uri.queryParameters['destination'], isNot('35.6586,139.7454'));
  });

  testWidgets('journey が index0 のままなら同じ徒歩CTAが再表示され再タップできる', (tester) async {
    final launched = <Uri>[];
    final container = _containerFor(
      launcher: (url) async {
        launched.add(url);
        return true;
      },
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    // 途中復帰相当: journey は index0 のまま。画面を再描画しても同じCTAのまま。
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('Google Mapsで新橋駅まで歩く'), findsOneWidget);

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(launched, hasLength(2));
  });

  testWidgets('advanceToLeg(1)後は電車CTAに切り替わり、URLがtransit・東京駅になる', (
    tester,
  ) async {
    final launched = <Uri>[];
    final container = _containerFor(
      launcher: (url) async {
        launched.add(url);
        return true;
      },
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    notifier.startJourney();
    notifier.advanceToLeg(1);
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('Google Mapsで東京駅まで行く'), findsOneWidget);
    expect(find.text('Google Mapsで新橋駅まで歩く'), findsNothing);

    await tester.tap(find.text('Google Mapsで東京駅まで行く'));
    await tester.pump();

    expect(launched, hasLength(1));
    final uri = launched.single;
    expect(uri.queryParameters['travelmode'], 'transit');
    expect(uri.queryParameters['destination'], '35.6812,139.7671');
  });

  testWidgets('launcherがfalseを返すとエラーバナーが表示され、CTAは再タップ可能なまま残る', (tester) async {
    var calls = 0;
    final container = _containerFor(
      launcher: (_) async {
        calls++;
        return false;
      },
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(find.text('Google Mapsを開けませんでした'), findsOneWidget);
    expect(find.text('Google Mapsで新橋駅まで歩く'), findsOneWidget);

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(calls, 2);
  });

  testWidgets('launcherが例外を投げてもエラーバナーが表示される', (tester) async {
    final container = _containerFor(
      launcher: (_) async => throw Exception('launch failed'),
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(find.text('Google Mapsを開けませんでした'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('現在地が無い場合、URLにoriginが含まれない', (tester) async {
    final launched = <Uri>[];
    final container = _containerFor(
      locationState: const LocationDenied(),
      launcher: (url) async {
        launched.add(url);
        return true;
      },
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(launched, hasLength(1));
    expect(launched.single.queryParameters.containsKey('origin'), isFalse);
  });

  testWidgets('起動成功時のみ journey が開始される', (tester) async {
    final container = _containerFor(launcher: (_) async => true);
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(container.read(appStateProvider).journey, isNull);
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(container.read(appStateProvider).journey, isNotNull);
  });

  testWidgets('起動失敗時は journey が開始されない', (tester) async {
    final container = _containerFor(launcher: (_) async => false);
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(container.read(appStateProvider).journey, isNull);
  });

  testWidgets('起動が例外を投げても journey は開始されない', (tester) async {
    final container = _containerFor(
      launcher: (_) async => throw Exception('launch failed'),
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(container.read(appStateProvider).journey, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('失効した経路の初回タップは launcher を呼ばず経路を無効化する', (tester) async {
    final clock = _Clock(DateTime(2026, 7, 18, 9, 0));
    var calls = 0;
    final container = _containerFor(
      now: clock.now,
      launcher: (_) async {
        calls++;
        return true;
      },
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 猶予（5分）を超過させてから初回タップする。
    clock.value = DateTime(2026, 7, 18, 9, 30);
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(calls, 0);
    final state = container.read(appStateProvider);
    expect(state.route, isNull);
    expect(state.journey, isNull);
    expect(state.screen, Screen.home);
  });

  testWidgets('行程開始済みなら失効していても launcher が呼ばれ経路は維持される', (tester) async {
    final clock = _Clock(DateTime(2026, 7, 18, 9, 0));
    var calls = 0;
    final container = _containerFor(
      now: clock.now,
      launcher: (_) async {
        calls++;
        return true;
      },
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    notifier.startJourney(); // 行程を開始済みにする。
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    clock.value = DateTime(2026, 7, 18, 9, 30); // 失効。
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(calls, 1);
    expect(container.read(appStateProvider).route, _threeLegRoute);
  });

  testWidgets('advanceToLeg後は完了済み区間に完了バッジ、現在区間に進行中バッジが出る', (tester) async {
    final container = _containerFor(launcher: (_) async => true);
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    notifier.startJourney();
    notifier.advanceToLeg(1);
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('完了'), findsOneWidget);
    expect(find.text('進行中'), findsOneWidget);
  });
}
