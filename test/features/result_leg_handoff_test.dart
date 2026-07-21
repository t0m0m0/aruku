import 'dart:async';

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

import '../support/route_plan_fixtures.dart';

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

// 最初の徒歩区間だけ geometry が欠落した経路。自動到着判定ができない場合でも、
// Google Maps から戻ったユーザーが手動で次区間へ進めることを検証する。
const _emptyFirstLegRoute = RoutePlan(
  from: '蒲田',
  to: '東京駅',
  totalKm: 1.5,
  totalMin: 23,
  budgetMin: 60,
  kcal: 80,
  walkKm: 1.5,
  walkRatio: 0.8,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: '蒲田',
      toName: '新橋駅',
      km: 1.5,
      minutes: 20,
      kcal: 80,
    ),
    _trainToTokyo,
  ],
  timelineNodes: [
    TimelineNode(time: '9:00', place: '蒲田', sub: '出発'),
    TimelineNode(time: '9:20', place: '新橋駅', sub: 'JR山手線 内回り'),
    TimelineNode(time: '9:23', place: '東京駅', sub: '到着'),
  ],
);

// 2区間とも geometry 欠落の徒歩。前区間を手動完了した直後の次区間で、handoff 前に
// 手動完了ボタンを出さないことを検証する。
const _twoEmptyLegRoute = RoutePlan(
  from: '蒲田',
  to: '東京タワー',
  totalKm: 3.0,
  totalMin: 40,
  budgetMin: 90,
  kcal: 160,
  walkKm: 3.0,
  walkRatio: 1.0,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: '蒲田',
      toName: '新橋駅',
      km: 1.5,
      minutes: 20,
      kcal: 80,
    ),
    RouteSegment(
      type: SegmentType.walk,
      fromName: '新橋駅',
      toName: '東京タワー',
      km: 1.5,
      minutes: 20,
      kcal: 80,
    ),
  ],
  timelineNodes: [
    TimelineNode(time: '9:00', place: '蒲田', sub: '出発'),
    TimelineNode(time: '9:20', place: '新橋駅', sub: '徒歩へ'),
    TimelineNode(time: '9:40', place: '東京タワー', sub: '到着'),
  ],
);

const _singleEmptyLegRoute = RoutePlan(
  from: '蒲田',
  to: '新橋駅',
  totalKm: 1.5,
  totalMin: 20,
  budgetMin: 60,
  kcal: 80,
  walkKm: 1.5,
  walkRatio: 1.0,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: '蒲田',
      toName: '新橋駅',
      km: 1.5,
      minutes: 20,
      kcal: 80,
    ),
  ],
  timelineNodes: [
    TimelineNode(time: '9:00', place: '蒲田', sub: '出発'),
    TimelineNode(time: '9:20', place: '新橋駅', sub: '到着'),
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

  testWidgets('外部起動の完了前に結果画面を離れた場合は非表示の journey を開始しない', (tester) async {
    final launchResult = Completer<bool>();
    final container = _containerFor(launcher: (_) => launchResult.future);
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    notifier.go(Screen.home);
    launchResult.complete(true);
    await tester.pump();
    await tester.pump();

    final state = container.read(appStateProvider);
    expect(state.screen, Screen.home);
    expect(state.journey, isNull);
  });

  testWidgets('外部起動の完了前に代替ルートへ切り替えた場合は別ルートの journey を開始しない', (tester) async {
    final launchResult = Completer<bool>();
    final container = _containerFor(
      plan: sampleRoutePlanWithAlternatives,
      launcher: (_) => launchResult.future,
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷ヒカリエ');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで原宿駅まで歩く'));
    await tester.pump();
    notifier.selectAlternative(0);
    launchResult.complete(true);
    await tester.pump();
    await tester.pump();

    final state = container.read(appStateProvider);
    expect(state.route, same(sampleAlternativeArrTime));
    expect(state.journey, isNull);
  });

  testWidgets('代替ルートへ切り替えると前ルートの起動失敗バナーを持ち越さない', (tester) async {
    final container = _containerFor(
      plan: sampleRoutePlanWithAlternatives,
      launcher: (_) async => false,
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷ヒカリエ');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで原宿駅まで歩く'));
    await tester.pump();
    expect(find.text('Google Mapsを開けませんでした'), findsOneWidget);

    notifier.selectAlternative(0);
    await tester.pump();

    expect(find.text('Google Mapsで代々木駅まで歩く'), findsOneWidget);
    expect(find.text('Google Mapsを開けませんでした'), findsNothing);
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

  testWidgets('polyline が空の開始済み区間は手動完了で次区間へ進める', (tester) async {
    final container = _containerFor(
      plan: _emptyFirstLegRoute,
      launcher: (_) async => true,
    );
    container.read(appStateProvider.notifier).setDestination('東京駅');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 行程開始前には誤操作防止のため手動完了を出さない。
    expect(find.text('この区間を完了'), findsNothing);
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(find.text('この区間を完了'), findsOneWidget);
    await tester.tap(find.text('この区間を完了'));
    await tester.pump();

    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);
    expect(find.text('Google Mapsで東京駅まで行く'), findsOneWidget);
    expect(find.text('この区間を完了'), findsNothing);
  });

  testWidgets('位置取得に失敗した開始済み区間はpolylineがあっても手動完了できる', (tester) async {
    final container = _containerFor(launcher: (_) async => true);
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    expect(find.text('この区間を完了'), findsNothing);

    // Google Maps から戻った際の到着確認が LocationDenied で失敗するケース。
    await notifier.onAppResumed();
    await tester.pump();
    expect(find.text('この区間を完了'), findsOneWidget);

    await tester.tap(find.text('この区間を完了'));
    await tester.pump();

    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);
    expect(find.text('Google Mapsで東京駅まで行く'), findsOneWidget);
  });

  testWidgets('到着閾値外の現在地でも復帰後は手動完了できる', (tester) async {
    final container = _containerFor(
      locationState: const LocationAvailable(GeoPoint(35.0, 139.0)),
      launcher: (_) async => true,
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    expect(find.text('この区間を完了'), findsNothing);

    // 有効な現在地でも終点の到着閾値外なら、自動進行せず手動フォールバックを出す。
    await notifier.onAppResumed();
    await tester.pump();
    expect(find.text('この区間を完了'), findsOneWidget);

    await tester.tap(find.text('この区間を完了'));
    await tester.pump();

    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);
    expect(find.text('Google Mapsで東京駅まで行く'), findsOneWidget);
  });

  testWidgets('前区間完了直後の geometry 欠落区間は handoff 前に手動完了を出さない', (tester) async {
    final container = _containerFor(
      plan: _twoEmptyLegRoute,
      launcher: (_) async => true,
    );
    container.read(appStateProvider.notifier).setDestination('東京タワー');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 区間0: handoff 後に手動完了が出て、完了で区間1へ進む。
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    await tester.tap(find.text('この区間を完了'));
    await tester.pump();
    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);

    // 区間1になった直後（journey は非 null）でも、まだ handoff していないので
    // 手動完了は出さない。1タップで未踏の区間を飛ばさせない。
    expect(find.text('Google Mapsで東京タワーまで歩く'), findsOneWidget);
    expect(find.text('この区間を完了'), findsNothing);

    // 区間1を handoff したら手動完了が出る。
    await tester.tap(find.text('Google Mapsで東京タワーまで歩く'));
    await tester.pump();
    expect(find.text('この区間を完了'), findsOneWidget);
  });

  testWidgets('前区間完了後、handoff 前のロック復帰では次区間を自動/手動完了させない', (tester) async {
    final container = _containerFor(
      // 復帰時の現在地が次区間（東京タワー）終点の閾値内でも自動完了させない。
      locationState: const LocationAvailable(_tokyoTowerPos),
      plan: _twoEmptyLegRoute,
      launcher: (_) async => true,
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 区間0を handoff→完了して区間1へ。区間1はまだ handoff していない。
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    await tester.tap(find.text('この区間を完了'));
    await tester.pump();
    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);

    // 区間1を起動せずに端末ロック等から復帰しても、到着判定を走らせない。
    await notifier.onAppResumed();
    await tester.pump();

    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);
    expect(find.text('この区間を完了'), findsNothing);
    expect(
      container.read(appStateProvider).journeyManualCompletionAvailable,
      isFalse,
    );
  });

  testWidgets('前区間完了後に猶予超過して待機した経路は次区間タップで失効させる', (tester) async {
    final clock = _Clock(DateTime(2026, 7, 18, 9, 0));
    var calls = 0;
    final container = _containerFor(
      plan: _emptyFirstLegRoute,
      now: clock.now,
      launcher: (_) async {
        calls++;
        return true;
      },
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京駅');
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 区間0を handoff→手動完了して未起動の区間1（電車）へ。
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    await tester.tap(find.text('この区間を完了'));
    await tester.pump();
    expect(container.read(appStateProvider).journey!.currentLegIndex, 1);

    // 区間0の handoff で launcher が1回呼ばれている。
    expect(calls, 1);

    // 区間1を起動せずハブで猶予（5分）超過。次区間タップは launcher を呼ばず失効させる。
    clock.value = DateTime(2026, 7, 18, 9, 30);
    await tester.tap(find.text('Google Mapsで東京駅まで行く'));
    await tester.pump();

    // 失効タップでは launcher を呼ばない（1 のまま）。
    expect(calls, 1);
    final state = container.read(appStateProvider);
    expect(state.route, isNull);
    expect(state.journey, isNull);
    expect(state.screen, Screen.home);
  });

  testWidgets('手動指定の出発地から検索した経路の先頭区間は計画起点を origin にする', (tester) async {
    final launched = <Uri>[];
    final container = _containerFor(
      // 現在地は計画起点とは別の座標。先頭区間は現在地ではなく計画起点を使う。
      locationState: const LocationAvailable(GeoPoint(35.0, 139.0)),
      launcher: (url) async {
        launched.add(url);
        return true;
      },
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    notifier.setOrigin('蒲田駅', latLng: const GeoPoint(35.5614, 139.7161));
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(launched, hasLength(1));
    // origin は計画起点（蒲田駅）。現在地 35.0,139.0 ではない。
    expect(launched.single.queryParameters['origin'], '35.5614,139.7161');
  });

  testWidgets('出発済みの先頭区間の再起動は計画起点ではなく現在地を origin にする', (tester) async {
    final launched = <Uri>[];
    final container = _containerFor(
      // 出発後にノイズの多い測位で戻った現在地。再起動はこの現在地を使う。
      locationState: const LocationAvailable(GeoPoint(35.6, 139.75)),
      launcher: (url) async {
        launched.add(url);
        return true;
      },
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('東京タワー');
    notifier.setOrigin('蒲田駅', latLng: const GeoPoint(35.5614, 139.7161));
    await notifier.startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 初回起動（計画起点）。
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    expect(launched.single.queryParameters['origin'], '35.5614,139.7161');

    // 区間途中で戻って同じ区間を再起動。計画起点へ引き戻さず現在地を使う。
    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();

    expect(launched, hasLength(2));
    expect(launched.last.queryParameters['origin'], '35.6,139.75');
  });

  testWidgets('polyline が空の最終区間は手動完了で行程完了になる', (tester) async {
    final container = _containerFor(
      plan: _singleEmptyLegRoute,
      launcher: (_) async => true,
    );
    container.read(appStateProvider.notifier).setDestination('新橋駅');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.text('Google Mapsで新橋駅まで歩く'));
    await tester.pump();
    await tester.tap(find.text('この区間を完了'));
    await tester.pump();

    expect(
      container.read(appStateProvider).journey!.currentLegIndex,
      _singleEmptyLegRoute.segments.length,
    );
    expect(find.text('目的地に到着しました'), findsOneWidget);
  });
}
