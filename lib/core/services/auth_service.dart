import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/auth_user.dart';
import 'auth_error.dart';

/// 認証バックエンドの抽象。テストではフェイクに差し替える。
abstract interface class AuthService {
  /// ログイン状態の変化を流す。サインイン時はユーザー、サインアウト時は null。
  Stream<AuthUser?> authStateChanges();

  /// 現在のユーザー。未ログインなら null。
  AuthUser? get currentUser;

  /// メール/パスワードで新規登録する。失敗時は [AuthException]。
  Future<AuthUser> signUp({required String email, required String password});

  /// メール/パスワードでログインする。失敗時は [AuthException]。
  Future<AuthUser> signIn({required String email, required String password});

  /// 匿名（ゲスト）でログインする。失敗時は [AuthException]。
  Future<AuthUser> signInAsGuest();

  Future<void> signOut();
}

/// FirebaseAuth を [AuthService] へ適合させる薄いラッパ。
class FirebaseAuthService implements AuthService {
  FirebaseAuthService(this._auth);

  final FirebaseAuth _auth;

  static AuthUser? _map(User? user) =>
      user == null ? null : AuthUser(uid: user.uid, email: user.email);

  @override
  Stream<AuthUser?> authStateChanges() => _auth.authStateChanges().map(_map);

  @override
  AuthUser? get currentUser => _map(_auth.currentUser);

  @override
  Future<AuthUser> signUp({required String email, required String password}) =>
      _run(
        () => _auth.createUserWithEmailAndPassword(
          email: email,
          password: password,
        ),
      );

  @override
  Future<AuthUser> signIn({required String email, required String password}) =>
      _run(
        () =>
            _auth.signInWithEmailAndPassword(email: email, password: password),
      );

  @override
  Future<AuthUser> signInAsGuest() => _run(_auth.signInAnonymously);

  @override
  Future<void> signOut() => _auth.signOut();

  /// 認証呼び出しを実行し、[FirebaseAuthException] を [AuthException] へ翻訳する。
  Future<AuthUser> _run(Future<UserCredential> Function() op) async {
    try {
      final cred = await op();
      final user = _map(cred.user);
      if (user == null) throw const AuthException(AuthErrorKind.unknown);
      return user;
    } on FirebaseAuthException catch (e) {
      throw AuthException(authErrorKindFromCode(e.code));
    }
  }
}

final authServiceProvider = Provider<AuthService>(
  (_) => FirebaseAuthService(FirebaseAuth.instance),
);
