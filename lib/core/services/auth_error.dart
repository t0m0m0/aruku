import '../../l10n/app_localizations.dart';

/// 認証処理で起こりうるエラーの種別。UI で日本語メッセージへ変換して表示する。
enum AuthErrorKind {
  invalidEmail,
  emailInUse,
  weakPassword,
  wrongCredentials,
  network,
  tooManyRequests,
  unknown,
}

/// FirebaseAuthException の code を [AuthErrorKind] へ写す。
/// メール/パスワード認証で実際に返りうるコードを網羅し、残りは unknown。
AuthErrorKind authErrorKindFromCode(String code) {
  switch (code) {
    case 'invalid-email':
      return AuthErrorKind.invalidEmail;
    case 'email-already-in-use':
      return AuthErrorKind.emailInUse;
    case 'weak-password':
      return AuthErrorKind.weakPassword;
    // 利用者列挙を防ぐため、認証情報の不一致はまとめて同じメッセージにする。
    case 'wrong-password':
    case 'user-not-found':
    case 'invalid-credential':
      return AuthErrorKind.wrongCredentials;
    case 'network-request-failed':
      return AuthErrorKind.network;
    case 'too-many-requests':
      return AuthErrorKind.tooManyRequests;
    default:
      return AuthErrorKind.unknown;
  }
}

/// 認証処理の失敗。UI 層は [authErrorMessage] でローカライズ済み文言を得る。
class AuthException implements Exception {
  const AuthException(this.kind);

  final AuthErrorKind kind;

  @override
  String toString() => 'AuthException($kind)';
}

/// [kind] に対応するローカライズ済みメッセージ。UI 層（BuildContext を持つ側）
/// で [AppLocalizations] を解決してから呼び出す。
String authErrorMessage(AppLocalizations l10n, AuthErrorKind kind) =>
    switch (kind) {
      AuthErrorKind.invalidEmail => l10n.authErrorInvalidEmail,
      AuthErrorKind.emailInUse => l10n.authErrorEmailInUse,
      AuthErrorKind.weakPassword => l10n.authErrorWeakPassword,
      AuthErrorKind.wrongCredentials => l10n.authErrorWrongCredentials,
      AuthErrorKind.network => l10n.authErrorNetwork,
      AuthErrorKind.tooManyRequests => l10n.authErrorTooManyRequests,
      AuthErrorKind.unknown => l10n.authErrorUnknown,
    };
