import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/e2e_helpers.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('初回起動はオンボーディング画面から始まる', (tester) async {
    final container = await makeContainer(onboardingDone: false);
    addTearDown(container.dispose);

    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.onboarding);
    expect(find.text('次へ'), findsOneWidget);
  });

  testWidgets('オンボーディング3ページを完了するとホーム画面へ遷移する', (tester) async {
    final container = await makeContainer(onboardingDone: false);
    addTearDown(container.dispose);

    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    // ページ 1 → 2
    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();

    // ページ 2 → 3
    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();

    expect(find.text('はじめる'), findsOneWidget);

    // ページ 3 → ホーム
    await tester.tap(find.text('はじめる'));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('オンボーディング完了済みの場合はホーム画面から始まる', (tester) async {
    final container = await makeContainer(onboardingDone: true);
    addTearDown(container.dispose);

    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.home);
    expect(find.text('次へ'), findsNothing);
    // ホーム画面固有のウィジェットが表示される（目的地未設定時のプレースホルダー）
    expect(find.text('どこへ歩く?'), findsOneWidget);
  });

  testWidgets('ページ 1→2 へ進んでもオンボーディング画面のままである', (tester) async {
    final container = await makeContainer(onboardingDone: false);
    addTearDown(container.dispose);

    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    // ページ 1 → 2 へ進む
    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();

    // Screen 状態はまだ onboarding
    expect(container.read(appStateProvider).screen, Screen.onboarding);
    // ページ 2 にも「次へ」ボタンがある
    expect(find.text('次へ'), findsOneWidget);
    expect(find.text('はじめる'), findsNothing);
  });
}
