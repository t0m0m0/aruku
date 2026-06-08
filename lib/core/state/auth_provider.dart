import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/auth_user.dart';
import '../services/auth_service.dart';

/// 認証状態を保持するノーティファイア。
/// バックエンドの authStateChanges を購読して state を追従させ、
/// サインアップ/イン/アウトの操作を公開する。操作の失敗は AuthException として
/// 呼び出し側（画面）に伝播し、フォームでメッセージ表示する。
class AuthNotifier extends AsyncNotifier<AuthUser?> {
  @override
  Future<AuthUser?> build() async {
    final service = ref.watch(authServiceProvider);
    final sub = service.authStateChanges().listen(
      (user) => state = AsyncData(user),
      // ストリームの一時的なエラーで未捕捉例外を出さない。
      onError: (_) {},
    );
    ref.onDispose(sub.cancel);
    return service.currentUser;
  }

  Future<void> signUp({required String email, required String password}) =>
      _authenticate(
        () => ref
            .read(authServiceProvider)
            .signUp(email: email, password: password),
      );

  Future<void> signIn({required String email, required String password}) =>
      _authenticate(
        () => ref
            .read(authServiceProvider)
            .signIn(email: email, password: password),
      );

  Future<void> signInAsGuest() =>
      _authenticate(ref.read(authServiceProvider).signInAsGuest);

  Future<void> signOut() async {
    await ref.read(authServiceProvider).signOut();
    state = const AsyncData(null);
  }

  /// 認証を実行し、成功時に state を更新する。失敗時は AuthException を再送出し、
  /// state は変更しない（現在のセッションを維持する）。
  Future<void> _authenticate(Future<AuthUser> Function() op) async {
    final user = await op();
    state = AsyncData(user);
  }
}

final authProvider = AsyncNotifierProvider<AuthNotifier, AuthUser?>(
  AuthNotifier.new,
);
