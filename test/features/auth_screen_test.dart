import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/auth_error.dart';
import 'package:aruku/core/services/auth_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/sync_service.dart';
import 'package:aruku/core/state/auth_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/auth/auth_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/fake_auth_service.dart';
import '../support/fake_sync_service.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeAuthService fake;

  ProviderContainer makeContainer() {
    final container = ProviderContainer(
      overrides: [
        authServiceProvider.overrideWithValue(fake),
        syncServiceProvider.overrideWithValue(FakeSyncService()),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        activityServiceProvider.overrideWithValue(_FakeActivityService()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  Widget wrap(ProviderContainer container) => UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: ArukuTheme.light(),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: const AuthScreen(),
    ),
  );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    fake = FakeAuthService();
    addTearDown(fake.dispose);
  });

  testWidgets('初期はログインモード、リンクでサインアップへ切替', (tester) async {
    final container = makeContainer();
    await container.read(authProvider.future);

    await tester.pumpWidget(wrap(container));
    await tester.pumpAndSettle();

    expect(find.text('ログイン'), findsWidgets);
    await tester.tap(find.text('アカウントをお持ちでない方はこちら'));
    await tester.pumpAndSettle();
    expect(find.text('アカウント作成'), findsOneWidget);
  });

  testWidgets('メールとパスワードでログインすると認証済みになる', (tester) async {
    final container = makeContainer();
    await container.read(authProvider.future);

    await tester.pumpWidget(wrap(container));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'a@example.com');
    await tester.enterText(find.byType(TextField).at(1), 'secret123');
    await tester.tap(find.widgetWithText(InkWell, 'ログイン'));
    await tester.pumpAndSettle();

    expect(container.read(authProvider).value!.email, 'a@example.com');
  });

  testWidgets('ゲストとして続けると匿名ユーザーになる', (tester) async {
    final container = makeContainer();
    await container.read(authProvider.future);

    await tester.pumpWidget(wrap(container));
    await tester.pumpAndSettle();

    await tester.tap(find.text('ゲストとして続ける'));
    await tester.pumpAndSettle();

    expect(container.read(authProvider).value!.isGuest, isTrue);
  });

  testWidgets('未入力で送信するとエラーを表示する', (tester) async {
    final container = makeContainer();
    await container.read(authProvider.future);

    await tester.pumpWidget(wrap(container));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(InkWell, 'ログイン'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('auth-error')), findsOneWidget);
    expect(container.read(authProvider).value, isNull);
  });

  testWidgets('認証失敗時はエラーメッセージを表示する', (tester) async {
    final container = makeContainer();
    await container.read(authProvider.future);
    fake.failWith = AuthErrorKind.wrongCredentials;

    await tester.pumpWidget(wrap(container));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'a@example.com');
    await tester.enterText(find.byType(TextField).at(1), 'bad');
    await tester.tap(find.widgetWithText(InkWell, 'ログイン'));
    await tester.pumpAndSettle();

    final l10n = await AppLocalizations.delegate.load(const Locale('ja'));
    expect(
      find.text(authErrorMessage(l10n, AuthErrorKind.wrongCredentials)),
      findsOneWidget,
    );
    expect(container.read(authProvider).value, isNull);
  });
}
