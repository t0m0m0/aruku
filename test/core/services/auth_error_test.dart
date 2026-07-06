import 'package:aruku/core/services/auth_error.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppLocalizations l10n;

  setUpAll(() async {
    l10n = await AppLocalizations.delegate.load(const Locale('ja'));
  });

  test('既知の Firebase エラーコードを種別へ写す', () {
    expect(authErrorKindFromCode('invalid-email'), AuthErrorKind.invalidEmail);
    expect(
      authErrorKindFromCode('email-already-in-use'),
      AuthErrorKind.emailInUse,
    );
    expect(authErrorKindFromCode('weak-password'), AuthErrorKind.weakPassword);
    expect(
      authErrorKindFromCode('wrong-password'),
      AuthErrorKind.wrongCredentials,
    );
    expect(
      authErrorKindFromCode('user-not-found'),
      AuthErrorKind.wrongCredentials,
    );
    expect(
      authErrorKindFromCode('invalid-credential'),
      AuthErrorKind.wrongCredentials,
    );
    expect(
      authErrorKindFromCode('network-request-failed'),
      AuthErrorKind.network,
    );
    expect(
      authErrorKindFromCode('too-many-requests'),
      AuthErrorKind.tooManyRequests,
    );
  });

  test('未知のコードは unknown', () {
    expect(authErrorKindFromCode('something-else'), AuthErrorKind.unknown);
  });

  test('各種別に日本語メッセージがある', () {
    for (final kind in AuthErrorKind.values) {
      expect(authErrorMessage(l10n, kind), isNotEmpty);
    }
  });
}
