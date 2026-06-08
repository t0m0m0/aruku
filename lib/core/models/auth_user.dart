import 'package:flutter/foundation.dart';

/// アプリ内で扱う認証済みユーザー。
/// Firebase の User を直接持ち回らず、必要な属性だけを写した値オブジェクト。
/// [email] が null の場合は匿名（ゲスト）ログインを表す。
@immutable
class AuthUser {
  const AuthUser({required this.uid, this.email});

  final String uid;
  final String? email;

  /// 匿名（ゲスト）ログインかどうか。
  bool get isGuest => email == null;

  /// UI 表示用のラベル。メールアドレス、ゲストは「ゲスト」。
  String get label => email ?? 'ゲスト';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthUser && uid == other.uid && email == other.email;

  @override
  int get hashCode => Object.hash(uid, email);
}
