import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  ProviderContainer makeContainer({required bool completed}) {
    final container = ProviderContainer(
      overrides: [onboardingCompletedProvider.overrideWithValue(completed)],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('オンボーディング完了済みなら初期画面は home', () {
    final container = makeContainer(completed: true);
    expect(container.read(appStateProvider).screen, Screen.home);
  });

  test('オンボーディング未完了なら初期画面は onboarding', () {
    final container = makeContainer(completed: false);
    expect(container.read(appStateProvider).screen, Screen.onboarding);
  });
}
