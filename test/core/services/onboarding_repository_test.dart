import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('初期状態は未完了（false）', () async {
    final prefs = await SharedPreferences.getInstance();
    final repo = OnboardingRepository(prefs);
    expect(repo.isCompleted(), isFalse);
  });

  test('markCompleted で完了状態が永続化される', () async {
    final prefs = await SharedPreferences.getInstance();
    final repo = OnboardingRepository(prefs);

    await repo.markCompleted();

    expect(repo.isCompleted(), isTrue);
    // 別インスタンスから読んでも永続化されている。
    expect(OnboardingRepository(prefs).isCompleted(), isTrue);
  });
}
