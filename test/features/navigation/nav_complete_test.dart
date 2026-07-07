import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/navigation/nav_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/route_plan_fixtures.dart';

/// build() で位置取得を起動せず、preset した状態を返すテスト用 Notifier。
class _NavNotifier extends AppNotifier {
  _NavNotifier(this._initial);
  final AppState _initial;

  @override
  AppState build() => _initial;

  void setPos(GeoPoint p) => state = state.copyWith(currentPosition: p);
}

void main() {
  // 目的地（sampleRoutePlan の徒歩終端）と経路途中点。
  const destination = GeoPoint(35.6592, 139.7031);
  const mid = GeoPoint(35.6790, 139.7035);

  setUpAll(() {
    // go_router が使う systemNavigator など platform channel の no-op 化は不要。
    // ここではジオコーダ等は使わないためチャネルモックは最小限。
    TestWidgetsFlutterBinding.ensureInitialized();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      const MethodChannel('flutter.baseflow.com/geolocator'),
      (call) async => null,
    );
  });

  Widget wrap(_NavNotifier notifier) => ProviderScope(
    overrides: [appStateProvider.overrideWith(() => notifier)],
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ArukuTheme.light(),
      home: const NavScreen(),
    ),
  );

  AppState navState() => AppState.initial.copyWith(
    screen: Screen.nav,
    route: sampleRoutePlan,
    currentPosition: mid,
  );

  testWidgets('目的地に到達すると完了画面へ自動遷移しサマリーを確定する', (tester) async {
    final notifier = _NavNotifier(navState());
    await tester.pumpWidget(wrap(notifier));
    await tester.pump();
    expect(notifier.state.screen, Screen.nav);

    notifier.setPos(destination);
    await tester.pump(); // build → postFrame をスケジュール
    await tester.pump(); // postFrame コールバック実行

    expect(notifier.state.screen, Screen.complete);
    expect(notifier.state.walkSummary, isNotNull);
    expect(notifier.state.walkSummary!.from, '新宿三丁目');
    expect(notifier.state.walkSummary!.to, '渋谷ヒカリエ');
    // 徒歩区間をほぼ歩き切っているため、徒歩距離は総徒歩距離に近い。
    expect(notifier.state.walkSummary!.distanceKm, greaterThan(4.5));
  });

  testWidgets('「歩き終わった」ボタンで途中でも完了画面へ遷移する', (tester) async {
    final notifier = _NavNotifier(navState());
    await tester.pumpWidget(wrap(notifier));
    await tester.pump();

    await tester.tap(find.byKey(const Key('nav-finish-button')));
    await tester.pump();

    expect(notifier.state.screen, Screen.complete);
    expect(notifier.state.walkSummary, isNotNull);
  });
}
