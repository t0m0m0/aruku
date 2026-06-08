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

/// 認証処理の失敗。UI 層は [message] をそのまま表示できる。
class AuthException implements Exception {
  const AuthException(this.kind);

  final AuthErrorKind kind;

  String get message => switch (kind) {
    AuthErrorKind.invalidEmail => 'メールアドレスの形式が正しくありません。',
    AuthErrorKind.emailInUse => 'このメールアドレスは既に登録されています。',
    AuthErrorKind.weakPassword => 'パスワードは6文字以上で設定してください。',
    AuthErrorKind.wrongCredentials => 'メールアドレスまたはパスワードが正しくありません。',
    AuthErrorKind.network => 'ネットワークに接続できませんでした。通信環境をご確認ください。',
    AuthErrorKind.tooManyRequests => '試行回数が多すぎます。しばらくしてからお試しください。',
    AuthErrorKind.unknown => '認証に失敗しました。時間をおいて再度お試しください。',
  };

  @override
  String toString() => 'AuthException($kind)';
}
