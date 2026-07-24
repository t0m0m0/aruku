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

class _FakeLocationService implements LocationService {
  const _FakeLocationService();

  @override
  Future<LocationState> request() async => const LocationDenied();
}

class _FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
}

const _shimbashiPos = GeoPoint(35.6665, 139.7580);
const _tokyoPos = GeoPoint(35.6812, 139.7671);

const _walkCtaLabel = 'Googleマップで徒歩ルートを開く';
const _handoffUnavailable = 'この区間の行き先が特定できず、Googleマップへ引き継げません';
const _startWithoutMaps = 'この区間を自分で進む';

RoutePlan _routeOf(List<RouteSegment> segments) => RoutePlan(
  from: '蒲田',
  to: '東京駅',
  totalKm: 3.0,
  totalMin: 30,
  budgetMin: 90,
  kcal: 120,
  walkKm: 1.5,
  walkRatio: 0.5,
  segments: segments,
  timelineNodes: const [
    TimelineNode(time: '9:00', place: '蒲田', sub: '出発'),
    TimelineNode(time: '9:30', place: '東京駅', sub: '到着'),
  ],
);

/// 先頭の徒歩区間が geometry も行き先名も欠く経路。`toName` は non-nullable だが
/// 上流パース結果によっては空文字のまま UI へ届く（#322/#323）。次区間に polyline が
/// あるため終点座標を経路構造から復元できる。
RoutePlan _recoverableRoute() => _routeOf([
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '蒲田',
    toName: '',
    km: 1.5,
    minutes: 20,
    kcal: 80,
  ),
  const RouteSegment(
    type: SegmentType.train,
    fromName: '',
    toName: '東京駅',
    minutes: 10,
    line: 'JR京浜東北線',
    polyline: [_shimbashiPos, _tokyoPos],
  ),
]);

/// 先頭区間の終点が座標でも名前でも復元できない経路。次区間も polyline・fromName を
/// 欠くため、引き継ぎ先を特定する手段が無い。
RoutePlan _unresolvableRoute() => _routeOf([
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '蒲田',
    toName: '',
    km: 1.5,
    minutes: 20,
    kcal: 80,
  ),
  const RouteSegment(
    type: SegmentType.train,
    fromName: '',
    toName: '東京駅',
    minutes: 10,
    line: 'JR京浜東北線',
  ),
]);

/// 2番目の区間だけ引き継ぎ先を特定できない経路。行程が始まった後にこの区間へ
/// 到達すると、handoff できないまま先へ進めない行き詰まりになり得る。
RoutePlan _unresolvableMidLegRoute() => _routeOf([
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '蒲田',
    toName: '新橋駅',
    km: 1.5,
    minutes: 20,
    kcal: 80,
    polyline: [GeoPoint(35.5614, 139.7161), _shimbashiPos],
  ),
  const RouteSegment(
    type: SegmentType.train,
    fromName: '新橋駅',
    toName: '',
    minutes: 10,
    line: 'JR京浜東北線',
  ),
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '',
    toName: '東京駅',
    km: 0.5,
    minutes: 8,
    kcal: 20,
  ),
]);

/// 2・3番目の区間がどちらも引き継ぎ先を欠く経路。区間2を完了した直後、再描画前に
/// 走る古いボタンコールバックが区間3を飛ばさないことを確かめるための固定経路。
RoutePlan _twoUnresolvableLegsRoute() => _routeOf([
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '蒲田',
    toName: '新橋駅',
    km: 1.5,
    minutes: 20,
    kcal: 80,
    polyline: [GeoPoint(35.5614, 139.7161), _shimbashiPos],
  ),
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '新橋駅',
    toName: '',
    km: 0.5,
    minutes: 8,
    kcal: 20,
  ),
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '',
    toName: '',
    km: 0.5,
    minutes: 8,
    kcal: 20,
  ),
  const RouteSegment(
    type: SegmentType.walk,
    fromName: '',
    toName: '東京駅',
    km: 0.5,
    minutes: 8,
    kcal: 20,
  ),
]);

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const ResultScreen(),
  ),
);

class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}

Future<({List<Uri> launched, ProviderContainer container, _Clock clock})>
_pumpResult(WidgetTester tester, RoutePlan plan, {int startAtLeg = 0}) async {
  final launched = <Uri>[];
  final clock = _Clock(DateTime(2026, 7, 24, 9, 0));
  final container = ProviderContainer(
    overrides: [
      nowProvider.overrideWithValue(clock.now),
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(const _FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
      urlLauncherProvider.overrideWithValue((uri) async {
        launched.add(uri);
        return true;
      }),
    ],
  );
  addTearDown(container.dispose);
  final notifier = container.read(appStateProvider.notifier);
  notifier.setDestination('東京駅');
  await notifier.startSearch();
  if (startAtLeg > 0) {
    notifier.startJourney();
    notifier.advanceToLeg(startAtLeg);
  }
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
  return (launched: launched, container: container, clock: clock);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('geometry も行き先名も欠く区間は次区間の始点座標を destination にする', (tester) async {
    final result = await _pumpResult(tester, _recoverableRoute());

    await tester.tap(find.text(_walkCtaLabel));
    await tester.pump();

    expect(result.launched, hasLength(1));
    expect(
      result.launched.single.queryParameters['destination'],
      '35.6665,139.758',
    );
  });

  testWidgets('引き継ぎ先を特定できない区間では Google Maps の CTA を出さず理由を示す', (tester) async {
    await _pumpResult(tester, _unresolvableRoute());

    expect(find.text(_walkCtaLabel), findsNothing);
    expect(find.text(_handoffUnavailable), findsOneWidget);
    expect(find.text(_startWithoutMaps), findsOneWidget);
  });

  testWidgets('引き継ぎ先を特定できない区間では空 destination の URL を起動しない', (tester) async {
    final result = await _pumpResult(tester, _unresolvableRoute());

    await tester.tap(find.text(_startWithoutMaps));
    await tester.pump();

    expect(result.launched, isEmpty);
  });

  testWidgets('引き継ぎ先が無くても先頭区間から行程を開始できる', (tester) async {
    // 開始できないと、この経路はタイムラインを眺めるだけの死んだ画面になる。
    final result = await _pumpResult(tester, _unresolvableRoute());
    expect(result.container.read(appStateProvider).journey, isNull);

    await tester.tap(find.text(_startWithoutMaps));
    await tester.pump();

    final state = result.container.read(appStateProvider);
    expect(state.journey, isNotNull);
    expect(state.journey!.currentLegIndex, 0);
    // 起動していないため handoff 済みの印が付かないと、失効からの行程保護も
    // 手動完了も落ちる。外部起動を飛ばしても状態遷移は通す。
    expect(state.journeyCurrentLegHandedOff, isTrue);
  });

  testWidgets('引き継ぎ不可区間は開始後に手動完了で先へ進める（行き詰まらせない）', (tester) async {
    final result = await _pumpResult(
      tester,
      _unresolvableMidLegRoute(),
      startAtLeg: 1,
    );

    expect(find.text(_handoffUnavailable), findsOneWidget);
    // 開始前は誤操作防止のため手動完了を出さない（既存の #305 の約束）。
    expect(find.text('この区間を完了'), findsNothing);

    await tester.tap(find.text(_startWithoutMaps));
    await tester.pump();
    expect(find.text('この区間を完了'), findsOneWidget);

    await tester.tap(find.text('この区間を完了'));
    await tester.pump();

    expect(result.container.read(appStateProvider).journey!.currentLegIndex, 2);
  });

  testWidgets('引き継ぎ不可区間を開始した行程は猶予切れの復帰でも失効させない', (tester) async {
    final result = await _pumpResult(tester, _unresolvableRoute());
    await tester.tap(find.text(_startWithoutMaps));
    await tester.pump();

    // 外部地図を開けない区間でも、歩いている間に isNow 経路の鮮度は切れる。
    result.clock.value = DateTime(
      2026,
      7,
      24,
      9,
      0,
    ).add(kRouteFreshness + const Duration(minutes: 1));
    await result.container.read(appStateProvider.notifier).onAppResumed();
    await tester.pump();

    expect(result.container.read(appStateProvider).journey, isNotNull);
    expect(result.container.read(appStateProvider).route, isNotNull);
  });

  testWidgets('引き継ぎ不可区間が連続しても手動完了の連打で次区間を飛ばさない', (tester) async {
    final result = await _pumpResult(
      tester,
      _twoUnresolvableLegsRoute(),
      startAtLeg: 1,
    );

    await tester.tap(find.text(_startWithoutMaps));
    await tester.pump();
    final complete = find.text('この区間を完了');
    await tester.tap(complete);
    // 再描画前に走る2度目のタップ。次区間はまだ開始していないので進めない。
    await tester.tap(complete, warnIfMissed: false);
    await tester.pump();

    expect(result.container.read(appStateProvider).journey!.currentLegIndex, 2);
  });
}
