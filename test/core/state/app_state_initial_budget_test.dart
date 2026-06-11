import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  ProviderContainer makeContainer() {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    return container;
  }

  test('初期 budgetMinutes は固定の既定値（60分）に一致する', () {
    final container = makeContainer();
    expect(
      container.read(appStateProvider).budgetMinutes,
      kInitialBudgetMinutes,
    );
    expect(kInitialBudgetMinutes, 60);
  });
}
