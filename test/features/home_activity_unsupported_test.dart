import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
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
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

Future<void> _pumpHome(
  WidgetTester tester, {
  required bool stepCountingSupported,
}) async {
  SharedPreferences.setMockInitialValues({});
  final repo = ActivityLogRepository(await SharedPreferences.getInstance());
  final ctrl = StreamController<ActivitySnapshot>();
  // close() の future を返さない。非 broadcast な StreamController は購読が無いと
  // done を配送できず future が完了しないため、非対応ケース（購読しない）で
  // tearDown がタイムアウトする。
  addTearDown(() {
    ctrl.close();
  });
  final container = ProviderContainer(
    overrides: [
      activityServiceProvider.overrideWithValue(_FakeActivityService(ctrl)),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityLogRepositoryProvider.overrideWith((ref) async => repo),
      stepCountingSupportedProvider.overrideWithValue(stepCountingSupported),
    ],
  );
  addTearDown(container.dispose);

  container.read(appStateProvider);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: const HomeScreen(),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('歩数計測が非対応なら理由を出し、0 の実績値は出さない', (tester) async {
    await _pumpHome(tester, stepCountingSupported: false);

    expect(find.byKey(const Key('home-activity-unsupported')), findsOneWidget);
    // 「0 歩 / 0 kcal」を計測結果として並べると、非対応と計測済みの 0 が
    // 画面から区別できない（#359 Phase 2 の無音の縮退）。
    expect(find.byKey(const Key('home-today-line')), findsNothing);
    // 週間目標も歩数由来の距離でしか進まない。達成度リングと目標距離を残すと
    // 「永久に 0% の進捗計」になる。
    expect(find.byKey(const Key('home-weekly-progress')), findsNothing);
  });

  testWidgets('対応環境では実績行と週間目標の進捗を出す', (tester) async {
    await _pumpHome(tester, stepCountingSupported: true);

    expect(find.byKey(const Key('home-today-line')), findsOneWidget);
    expect(find.byKey(const Key('home-weekly-progress')), findsOneWidget);
    expect(find.byKey(const Key('home-activity-unsupported')), findsNothing);
  });
}
