import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  ProviderContainer makeContainer({int? budget}) {
    final container = ProviderContainer(
      overrides: [
        if (budget != null)
          defaultBudgetMinutesProvider.overrideWithValue(budget),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('初期 budgetMinutes は時間予算の設定値に一致する', () {
    final container = makeContainer(budget: 90);
    expect(container.read(appStateProvider).budgetMinutes, 90);
  });

  test('時間予算の設定値を変えると初期 budgetMinutes も追従する', () {
    expect(makeContainer(budget: 30).read(appStateProvider).budgetMinutes, 30);
    expect(
      makeContainer(budget: 120).read(appStateProvider).budgetMinutes,
      120,
    );
  });

  test('時間予算を未指定なら defaults の 60 分', () {
    expect(makeContainer().read(appStateProvider).budgetMinutes, 60);
  });
}
