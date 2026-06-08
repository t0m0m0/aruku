import 'package:aruku/core/models/favorite_place.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/favorites_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
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
    void Function(RoutePhase)? onProgress,
  }) async => result;
}

const _plan = RoutePlan(
  from: '現在地',
  to: '渋谷駅',
  totalKm: 4,
  totalMin: 40,
  budgetMin: 60,
  kcal: 150,
  walkKm: 4,
  walkRatio: 1,
  segments: [],
  timelineNodes: [TimelineNode(time: '9:00', place: '現在地', sub: '出発')],
);

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const ResultScreen()),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('スターをタップすると目的地がお気に入りに保存・解除される', (tester) async {
    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_FixedRouteService(_plan)),
      ],
    );
    addTearDown(container.dispose);

    container.read(appStateProvider.notifier).setDestination('渋谷駅');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    final star = find.byKey(const ValueKey('result-star-button'));
    expect(star, findsOneWidget);

    final notifier = container.read(favoritesProvider.notifier);
    expect(notifier.isFavorite(const FavoritePlace(name: '渋谷駅')), isFalse);

    await tester.tap(star);
    await tester.pumpAndSettle();
    expect(notifier.isFavorite(const FavoritePlace(name: '渋谷駅')), isTrue);

    await tester.tap(star);
    await tester.pumpAndSettle();
    expect(notifier.isFavorite(const FavoritePlace(name: '渋谷駅')), isFalse);
  });
}
