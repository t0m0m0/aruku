import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/route_plan_builder.dart';
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

const _walkCtaLabel = 'Googleマップで徒歩ルートを開く';

const _origin = GeoPoint(35.5614, 139.7161);
const _midway = GeoPoint(35.5680, 139.6900);
const _kugahara = GeoPoint(35.5750, 139.6810);
const _ikegami = GeoPoint(35.5810, 139.7020);

/// #337 の実例（現在地 → 久が原）。乗車駅探索の継ぎ目で徒歩が 3 本並び、うち 1 本は
/// 端点名が空。`buildRoutePlan` を通して組むことで統合の有無が表示へ出る。
RoutePlan _consecutiveWalkPlan() => buildRoutePlan(
  from: '現在地',
  to: '池上',
  segments: [
    const RouteSegment(
      type: SegmentType.walk,
      fromName: '現在地',
      toName: '',
      minutes: 40,
      km: 2.9,
      kcal: 163,
      polyline: [_origin, _midway],
    ),
    const RouteSegment(
      type: SegmentType.walk,
      fromName: '',
      toName: '久が原',
      minutes: 12,
      km: 0.8,
      kcal: 46,
      polyline: [_midway, _kugahara],
    ),
    RouteSegment(
      type: SegmentType.train,
      fromName: '久が原',
      toName: '池上',
      minutes: 10,
      km: 2.0,
      line: '東急池上線',
      depTime: DateTime(2026, 7, 24, 15, 51),
      arrTime: DateTime(2026, 7, 24, 16, 1),
    ),
  ],
  departure: const TimeValue(h: 14, m: 51),
  budgetMin: 90,
  departureAt: DateTime(2026, 7, 24, 14, 51),
);

/// 末尾の徒歩が geometry を欠く経路（#322/#323 と同じ欠落）。統合後に先頭の
/// geometry だけを残すと、引き継ぎ先が「歩き終える地点」ではなく継ぎ目の中間点に化ける。
RoutePlan _geometrylessTailWalkPlan() => buildRoutePlan(
  from: '現在地',
  to: '池上',
  segments: [
    const RouteSegment(
      type: SegmentType.walk,
      fromName: '現在地',
      toName: '',
      minutes: 40,
      km: 2.9,
      kcal: 163,
      polyline: [_origin, _midway],
    ),
    const RouteSegment(
      type: SegmentType.walk,
      fromName: '',
      toName: '久が原',
      minutes: 12,
      km: 0.8,
      kcal: 46,
    ),
    RouteSegment(
      type: SegmentType.train,
      fromName: '久が原',
      toName: '池上',
      minutes: 10,
      km: 2.0,
      line: '東急池上線',
      polyline: const [_kugahara, _ikegami],
      depTime: DateTime(2026, 7, 24, 15, 51),
      arrTime: DateTime(2026, 7, 24, 16, 1),
    ),
  ],
  departure: const TimeValue(h: 14, m: 51),
  budgetMin: 90,
  departureAt: DateTime(2026, 7, 24, 14, 51),
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

Future<List<Uri>> _pumpResult(WidgetTester tester, RoutePlan plan) async {
  final launched = <Uri>[];
  final container = ProviderContainer(
    overrides: [
      nowProvider.overrideWithValue(() => DateTime(2026, 7, 24, 14, 51)),
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
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
  notifier.setDestination('池上');
  await notifier.startSearch();
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
  return launched;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('連続する徒歩は1枚のカードにまとまり中間の通過点行を出さない', (tester) async {
    await _pumpResult(tester, _consecutiveWalkPlan());

    expect(find.text('3.7km'), findsOneWidget);
    expect(find.text('2.9km'), findsNothing);
    expect(find.text('0.8km'), findsNothing);
    // 「久が原から久が原へ歩く」ように読める重複行を出さない。
    expect(find.text('久が原'), findsOneWidget);
  });

  testWidgets('地名が空欄の通過点行が描かれない', (tester) async {
    await _pumpResult(tester, _consecutiveWalkPlan());

    expect(find.text(''), findsNothing);
  });

  testWidgets('統合された徒歩レッグの引き継ぎ先は中間点でなく歩き終える地点', (tester) async {
    final launched = await _pumpResult(tester, _consecutiveWalkPlan());

    await tester.tap(find.text(_walkCtaLabel));
    await tester.pump();

    expect(launched, hasLength(1));
    expect(launched.single.queryParameters['destination'], '35.575,139.681');
  });

  testWidgets('末尾の徒歩が geometry を欠いても引き継ぎ先が継ぎ目の中間点に化けない', (tester) async {
    final launched = await _pumpResult(tester, _geometrylessTailWalkPlan());

    await tester.tap(find.text(_walkCtaLabel));
    await tester.pump();

    expect(launched, hasLength(1));
    // 座標不明として次区間（乗車駅）の始点へフォールバックする。中間点 35.568,139.69
    // へ案内すると、その地点で徒歩レッグ全体が完了扱いになる。
    expect(launched.single.queryParameters['destination'], '35.575,139.681');
  });
}
