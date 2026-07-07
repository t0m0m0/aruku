import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
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

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const HomeScreen(),
  ),
);

void main() {
  testWidgets('計測した歩数がサマリーに表示される', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final repo = ActivityLogRepository(await SharedPreferences.getInstance());
    final controller = StreamController<ActivitySnapshot>();
    final container = ProviderContainer(
      overrides: [
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        // 履歴ロードをマイクロタスクで解決させ、実時間待ちを避ける
        // （runAsync 中の実待機は google_fonts の実ネットワーク取得を誘発する）。
        activityLogRepositoryProvider.overrideWith((ref) async => repo),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(controller.close);

    container.read(appStateProvider); // build() を起動
    await tester.pumpWidget(_wrap(container));

    await tester.runAsync(() async {
      // 権限要求と履歴ロード（共にマイクロタスク）を解決して購読を確立。
      await Future<void>.delayed(Duration.zero);
      controller.add(ActivitySnapshot.fromSteps(2000));
      await Future<void>.delayed(Duration.zero);
    });
    await tester.pump();

    // v2: 歩数は週間目標カード内に 3 桁区切りで表示される。
    expect(find.byKey(const Key('home-weekly-goal')), findsOneWidget);
    expect(find.text('2,000'), findsOneWidget);
    expect(find.textContaining('歩'), findsWidgets);
  });
}
