import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/onboarding/onboarding_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// build() で位置取得・活動量計測を起動せず、初期状態をそのまま返す
/// テスト用 Notifier。
class _TestNotifier extends AppNotifier {
  @override
  AppState build() => AppState.initial;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  ProviderContainer makeContainer(WidgetTester tester) {
    final container = ProviderContainer(
      overrides: [appStateProvider.overrideWith(_TestNotifier.new)],
    );
    addTearDown(container.dispose);
    return container;
  }

  Widget wrap(ProviderContainer container) => UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: ArukuTheme.light(),
      home: const OnboardingScreen(),
    ),
  );

  double dotWidth(WidgetTester tester, int i) =>
      tester.getSize(find.byKey(Key('onboard-dot-$i'))).width;

  testWidgets('初期表示は Page1・CTA は「次へ」で「はじめる」は非表示', (tester) async {
    await tester.pumpWidget(wrap(makeContainer(tester)));
    await tester.pump();

    expect(find.byKey(const Key('onboard-page-0')), findsOneWidget);
    expect(find.text('次へ'), findsOneWidget);
    expect(find.text('はじめる'), findsNothing);

    // ドット 0 がアクティブ（幅が広い）。
    expect(dotWidth(tester, 0), greaterThan(dotWidth(tester, 1)));
  });

  testWidgets('スワイプでページが進み、ドットのアクティブが連動する', (tester) async {
    await tester.pumpWidget(wrap(makeContainer(tester)));
    await tester.pump();

    await tester.fling(find.byType(PageView), const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();

    // 2ページ目に移動し、ドット 1 がアクティブに。
    expect(find.byKey(const Key('onboard-page-1')), findsOneWidget);
    expect(dotWidth(tester, 1), greaterThan(dotWidth(tester, 0)));
  });

  testWidgets('「次へ」で最終ページに到達し CTA が「はじめる」に変わる', (tester) async {
    await tester.pumpWidget(wrap(makeContainer(tester)));
    await tester.pump();

    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();
    // Page2 でもまだ「次へ」。
    expect(find.text('次へ'), findsOneWidget);

    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();

    // 最終ページ。CTA は「はじめる」、ドット 2 がアクティブ。
    expect(find.text('はじめる'), findsOneWidget);
    expect(find.text('次へ'), findsNothing);
    expect(dotWidth(tester, 2), greaterThan(dotWidth(tester, 0)));
  });

  testWidgets('最終ページの「はじめる」でホーム画面へ遷移する', (tester) async {
    final container = makeContainer(tester);
    await tester.pumpWidget(wrap(container));
    await tester.pump();

    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.onboarding);
    await tester.tap(find.text('はじめる'));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('「はじめる」で完了状態が永続化される', (tester) async {
    final container = makeContainer(tester);
    await tester.pumpWidget(wrap(container));
    await tester.pump();

    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();

    final repo = await container.read(onboardingRepositoryProvider.future);
    expect(repo.isCompleted(), isFalse);

    await tester.tap(find.text('はじめる'));
    await tester.pumpAndSettle();

    expect(repo.isCompleted(), isTrue);
  });
}
