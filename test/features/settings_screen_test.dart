import 'package:aruku/core/constants/app_constants.dart';
import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/services/url_launcher.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/features/settings/settings_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _ThrowingRepository extends SettingsRepository {
  _ThrowingRepository(super.prefs);

  @override
  Future<void> save(AppSettings settings) async =>
      throw StateError('save failed');
}

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

Future<ProviderContainer> _container() async {
  final prefs = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
    ],
  );
}

Widget _wrap(ProviderContainer container, Widget child) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: child,
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('主要な設定項目が表示される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('設定'), findsOneWidget);
    expect(find.text('通知を受け取る'), findsOneWidget);
    expect(find.text('端末設定を開く'), findsOneWidget);
    expect(find.text('アカウント'), findsNothing);
  });

  testWidgets('通知スイッチを切ると永続化される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('switch_notifications')));
    await tester.pumpAndSettle();

    expect(
      container.read(settingsProvider).value!.notificationsEnabled,
      isFalse,
    );
  });

  testWidgets('ヘルスケア連携セクションが表示される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('ヘルスケア連携'), findsOneWidget);
    expect(find.text('ウォーキングを記録する'), findsOneWidget);
    expect(find.byKey(const Key('switch_healthkit')), findsOneWidget);
  });

  testWidgets('ヘルスケア連携スイッチをオンにすると永続化される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('switch_healthkit')));
    await tester.pumpAndSettle();

    expect(container.read(settingsProvider).value!.healthKitEnabled, isTrue);

    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().healthKitEnabled, isTrue);
  });

  testWidgets('週間目標セクションと既定選択が表示される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('週間目標'), findsOneWidget);
    // 既定 10km のプリセットが選択済み。
    expect(find.byKey(const Key('goal_preset_10')), findsOneWidget);
    expect(find.byKey(const Key('goal_preset_20')), findsOneWidget);
  });

  testWidgets('週間目標プリセットをタップすると保存される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('goal_preset_20')));
    await tester.pumpAndSettle();

    expect(container.read(settingsProvider).value!.weeklyGoalKm, 20);

    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().weeklyGoalKm, 20);
  });

  testWidgets('選択中のプリセットだけが強調表示され、選択で切り替わる', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    Color chipColor(String key) => tester
        .widget<Material>(
          find.descendant(
            of: find.byKey(Key(key)),
            matching: find.byType(Material),
          ),
        )
        .color!;

    // 既定 10km が選択色、20km は非選択色（両者は異なる）。
    final selectedColor = chipColor('goal_preset_10');
    final unselectedColor = chipColor('goal_preset_20');
    expect(selectedColor, isNot(unselectedColor));

    await tester.tap(find.byKey(const Key('goal_preset_20')));
    await tester.pumpAndSettle();

    // 選択が 20km へ移り、強調色が入れ替わる。
    expect(chipColor('goal_preset_20'), selectedColor);
    expect(chipColor('goal_preset_10'), unselectedColor);
  });

  testWidgets('保存に失敗するとSnackBarで通知する', (tester) async {
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        onboardingCompletedProvider.overrideWithValue(true),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        activityServiceProvider.overrideWithValue(_FakeActivityService()),
        settingsRepositoryProvider.overrideWith(
          (ref) async => _ThrowingRepository(prefs),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('switch_healthkit')));
    await tester.pumpAndSettle();

    expect(find.text('設定を保存できませんでした'), findsOneWidget);
    // 失敗した変更は state に反映されない。
    expect(container.read(settingsProvider).value!.healthKitEnabled, isFalse);
  });

  testWidgets('法的情報セクションと利用規約・プライバシーポリシー行が表示される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('法的情報'), findsOneWidget);
    expect(find.text('利用規約'), findsOneWidget);
    expect(find.text('プライバシーポリシー'), findsOneWidget);
  });

  testWidgets('利用規約行をタップすると利用規約URLで launcher が呼ばれる', (tester) async {
    final launched = <Uri>[];
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        onboardingCompletedProvider.overrideWithValue(true),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        activityServiceProvider.overrideWithValue(_FakeActivityService()),
        urlLauncherProvider.overrideWithValue((url) async {
          launched.add(url);
          return true;
        }),
      ],
    );
    addTearDown(container.dispose);
    // 全セクションが 1 画面に収まる高さにし、末尾の法的情報行を確実にタップする。
    await tester.binding.setSurfaceSize(const Size(800, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('link_terms')));
    await tester.pumpAndSettle();

    expect(launched, [Uri.parse(AppConstants.termsOfServiceUrl)]);
  });

  testWidgets('プライバシーポリシー行をタップするとプライバシーURLで launcher が呼ばれる', (tester) async {
    final launched = <Uri>[];
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        onboardingCompletedProvider.overrideWithValue(true),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        activityServiceProvider.overrideWithValue(_FakeActivityService()),
        urlLauncherProvider.overrideWithValue((url) async {
          launched.add(url);
          return true;
        }),
      ],
    );
    addTearDown(container.dispose);
    // 全セクションが 1 画面に収まる高さにし、末尾の法的情報行を確実にタップする。
    await tester.binding.setSurfaceSize(const Size(800, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('link_privacy')));
    await tester.pumpAndSettle();

    expect(launched, [Uri.parse(AppConstants.privacyPolicyUrl)]);
  });

  testWidgets('法的情報の各行はボタンとして公開される（VoiceOver）', (tester) async {
    final handle = tester.ensureSemantics();
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(
      tester.getSemantics(find.text('利用規約')),
      containsSemantics(isButton: true),
    );
    expect(
      tester.getSemantics(find.text('プライバシーポリシー')),
      containsSemantics(isButton: true),
    );
    handle.dispose();
  });

  testWidgets('ホームの設定ボタンで設定画面へ遷移する', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);
    container.read(appStateProvider); // build() を起動

    await tester.pumpWidget(_wrap(container, const HomeScreen()));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.home);

    await tester.tap(find.byKey(const Key('home-settings-button')));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.settings);
  });

  testWidgets('ホームの設定ボタンにVoiceOverラベルがある', (tester) async {
    final handle = tester.ensureSemantics();
    final container = await _container();
    addTearDown(container.dispose);
    container.read(appStateProvider);

    await tester.pumpWidget(_wrap(container, const HomeScreen()));
    await tester.pumpAndSettle();

    expect(
      tester.getSemantics(find.byKey(const Key('home-settings-button'))),
      containsSemantics(label: '設定を開く', isButton: true),
    );
    handle.dispose();
  });

  testWidgets('通知スイッチはラベルと状態が1ノードに統合される（VoiceOver）', (tester) async {
    final handle = tester.ensureSemantics();
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(
      tester.getSemantics(find.text('通知を受け取る')),
      containsSemantics(label: '通知を受け取る', hasToggledState: true),
    );
    handle.dispose();
  });

  testWidgets('目標プリセットは選択状態をボタンとして公開する（VoiceOver）', (tester) async {
    final handle = tester.ensureSemantics();
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    // 既定 10km は選択、20km は非選択。
    expect(
      tester.getSemantics(find.byKey(const Key('goal_preset_10'))),
      containsSemantics(isButton: true, isSelected: true),
    );
    expect(
      tester.getSemantics(find.byKey(const Key('goal_preset_20'))),
      containsSemantics(isButton: true, isSelected: false),
    );
    handle.dispose();
  });

  testWidgets('権限リンク行はボタンとして公開され、戻るボタンにラベルがある（VoiceOver）', (tester) async {
    final handle = tester.ensureSemantics();
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(
      tester.getSemantics(find.text('位置情報・通知の権限')),
      containsSemantics(isButton: true),
    );
    expect(find.byTooltip('戻る'), findsOneWidget);
    handle.dispose();
  });
}
