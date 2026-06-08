import 'package:aruku/core/services/auth_error.dart';
import 'package:aruku/core/services/auth_service.dart';
import 'package:aruku/core/state/auth_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_auth_service.dart';

void main() {
  late FakeAuthService fake;

  ProviderContainer makeContainer() {
    final container = ProviderContainer(
      overrides: [authServiceProvider.overrideWithValue(fake)],
    );
    addTearDown(container.dispose);
    return container;
  }

  setUp(() {
    fake = FakeAuthService();
    addTearDown(fake.dispose);
  });

  test('初期状態は未ログイン（null）', () async {
    final container = makeContainer();
    expect(await container.read(authProvider.future), isNull);
  });

  test('signUp で認証済みユーザーになる', () async {
    final container = makeContainer();
    await container.read(authProvider.future);

    await container
        .read(authProvider.notifier)
        .signUp(email: 'a@example.com', password: 'secret123');

    final user = container.read(authProvider).value;
    expect(user, isNotNull);
    expect(user!.email, 'a@example.com');
    expect(user.isGuest, isFalse);
  });

  test('signInAsGuest で匿名ユーザーになる', () async {
    final container = makeContainer();
    await container.read(authProvider.future);

    await container.read(authProvider.notifier).signInAsGuest();

    expect(container.read(authProvider).value!.isGuest, isTrue);
  });

  test('signOut で未ログインに戻る', () async {
    final container = makeContainer();
    await container.read(authProvider.future);
    final notifier = container.read(authProvider.notifier);
    await notifier.signInAsGuest();

    await notifier.signOut();

    expect(container.read(authProvider).value, isNull);
  });

  test('失敗時は AuthException を投げ、状態は変わらない', () async {
    final container = makeContainer();
    await container.read(authProvider.future);
    fake.failWith = AuthErrorKind.emailInUse;

    await expectLater(
      container
          .read(authProvider.notifier)
          .signUp(email: 'a@example.com', password: 'secret123'),
      throwsA(isA<AuthException>()),
    );
    expect(container.read(authProvider).value, isNull);
  });
}
