import 'dart:async';

import 'package:aruku/core/models/auth_user.dart';
import 'package:aruku/core/services/auth_error.dart';
import 'package:aruku/core/services/auth_service.dart';

/// テスト用のインメモリ [AuthService]。
/// [failWith] を設定すると次の認証呼び出しで [AuthException] を投げる。
class FakeAuthService implements AuthService {
  FakeAuthService({AuthUser? initialUser}) : _current = initialUser;

  final _controller = StreamController<AuthUser?>.broadcast();
  AuthUser? _current;

  /// 設定されている場合、次の sign 系呼び出しで対応する例外を投げる。
  AuthErrorKind? failWith;

  void dispose() => _controller.close();

  @override
  Stream<AuthUser?> authStateChanges() => _controller.stream;

  @override
  AuthUser? get currentUser => _current;

  @override
  Future<AuthUser> signUp({
    required String email,
    required String password,
  }) async => _maybeFail() ?? _set(AuthUser(uid: 'uid-$email', email: email));

  @override
  Future<AuthUser> signIn({
    required String email,
    required String password,
  }) async => _maybeFail() ?? _set(AuthUser(uid: 'uid-$email', email: email));

  @override
  Future<AuthUser> signInAsGuest() async =>
      _maybeFail() ?? _set(const AuthUser(uid: 'guest'));

  @override
  Future<void> signOut() async {
    _current = null;
    _controller.add(null);
  }

  AuthUser? _maybeFail() {
    final kind = failWith;
    if (kind == null) return null;
    failWith = null;
    throw AuthException(kind);
  }

  AuthUser _set(AuthUser user) {
    _current = user;
    _controller.add(user);
    return user;
  }
}
