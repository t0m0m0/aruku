import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/services/url_launcher.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_button.dart';
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

const _kamataPos = GeoPoint(35.5614, 139.7161);
const _shimbashiPos = GeoPoint(35.6665, 139.7580);

/// #336: モードアイコンチップ（52x52固定Container）専用の寸法。
/// `_JourneyCompleteRow` の Container は height:52 のみで width を指定しない
/// ため、width:52 での判定はチップの有無だけを拾う。
bool _isModeChip(Widget widget) =>
    widget is Container && widget.constraints?.maxWidth == 52;

RoutePlan _routeLedBy(RouteSegment first) => RoutePlan(
  from: '蒲田',
  to: '東京駅',
  totalKm: 1.5,
  totalMin: 20,
  budgetMin: 90,
  kcal: 80,
  walkKm: 1.5,
  walkRatio: 1.0,
  segments: [first],
  timelineNodes: const [
    TimelineNode(time: '9:00', place: '蒲田', sub: '出発'),
    TimelineNode(time: '9:20', place: '東京駅', sub: '到着'),
  ],
);

const _walkLeg = RouteSegment(
  type: SegmentType.walk,
  fromName: '蒲田',
  toName: '東京駅',
  km: 1.5,
  minutes: 20,
  kcal: 80,
  polyline: [_kamataPos, _shimbashiPos],
);

const _trainLeg = RouteSegment(
  type: SegmentType.train,
  fromName: '蒲田',
  toName: '東京駅',
  minutes: 10,
  line: 'JR京浜東北線',
  polyline: [_kamataPos, _shimbashiPos],
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

Future<void> _pumpResult(WidgetTester tester, RoutePlan plan) async {
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
      locationServiceProvider.overrideWithValue(const _FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
      urlLauncherProvider.overrideWithValue((_) async => true),
    ],
  );
  addTearDown(container.dispose);
  container.read(appStateProvider.notifier).setDestination('東京駅');
  await container.read(appStateProvider.notifier).startSearch();
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('徒歩区間のCTAにモードアイコンチップが無い', (tester) async {
    await _pumpResult(tester, _routeLedBy(_walkLeg));

    expect(find.byWidgetPredicate(_isModeChip), findsNothing);
    expect(find.byType(ArukuButton), findsOneWidget);
  });

  testWidgets('電車区間のCTAにモードアイコンチップが無い', (tester) async {
    await _pumpResult(tester, _routeLedBy(_trainLeg));

    expect(find.byWidgetPredicate(_isModeChip), findsNothing);
    expect(find.byType(ArukuButton), findsOneWidget);
  });
}
