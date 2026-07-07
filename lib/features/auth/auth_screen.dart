import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/services/auth_error.dart';
import '../../core/state/app_state.dart';
import '../../core/state/auth_provider.dart';
import '../../core/state/sync_provider.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';

part 'auth_widgets.dart';

/// サインアップ/ログイン画面。メール・パスワードでの新規登録とログインを
/// 1 画面でトグルし、ゲスト（匿名）での利用も選べる。成功すると設定画面へ戻る。
class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key});

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

enum _Mode { login, signUp }

class _AuthScreenState extends ConsumerState<AuthScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  _Mode _mode = _Mode.login;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _toggleMode() {
    setState(() {
      _mode = _mode == _Mode.login ? _Mode.signUp : _Mode.login;
      _error = null;
    });
  }

  Future<void> _submit() async {
    if (_submitting) return;
    final email = _email.text.trim();
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) {
      setState(
        () => _error = AppLocalizations.of(context).authValidationEmptyFields,
      );
      return;
    }
    await _run(() {
      final notifier = ref.read(authProvider.notifier);
      return _mode == _Mode.login
          ? notifier.signIn(email: email, password: password)
          : notifier.signUp(email: email, password: password);
    });
  }

  Future<void> _continueAsGuest() {
    if (_submitting) return Future.value();
    return _run(() => ref.read(authProvider.notifier).signInAsGuest());
  }

  /// 認証操作を実行し、送信中フラグとエラー表示を管理する。
  /// 成功したら設定画面へ戻る。
  Future<void> _run(Future<void> Function() op) async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await op();
      if (!mounted) return;
      // ログイン直後にクラウド同期を走らせる（本物のアカウントのみ）。
      final user = ref.read(authProvider).value;
      if (user != null && !user.isGuest) {
        unawaited(ref.read(syncProvider.notifier).sync());
      }
      ref.read(appStateProvider.notifier).go(Screen.settings);
    } on AuthException catch (e) {
      if (!mounted) return;
      setState(
        () => _error = authErrorMessage(AppLocalizations.of(context), e.kind),
      );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final isLogin = _mode == _Mode.login;

    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
              child: IconButton(
                onPressed: () =>
                    ref.read(appStateProvider.notifier).go(Screen.settings),
                tooltip: l10n.commonBack,
                icon: Ic.chevron(size: 20, color: c.ink, dir: ChevronDir.left),
                style: IconButton.styleFrom(
                  backgroundColor: Colors.transparent,
                  fixedSize: const Size(40, 40),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
                children: [
                  Text(
                    isLogin ? l10n.authLoginTitle : l10n.authSignUpTitle,
                    style: jpStyle(
                      size: 28,
                      weight: FontWeight.w800,
                      color: c.ink,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    isLogin ? l10n.authLoginSubtitle : l10n.authSignUpSubtitle,
                    style: jpStyle(
                      size: 13,
                      weight: FontWeight.w600,
                      color: c.ink3,
                    ),
                  ),
                  const SizedBox(height: 24),
                  _AuthField(
                    controller: _email,
                    hint: l10n.authEmailHint,
                    keyboardType: TextInputType.emailAddress,
                  ),
                  const SizedBox(height: 12),
                  _AuthField(
                    controller: _password,
                    hint: l10n.authPasswordHint,
                    obscure: true,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      key: const Key('auth-error'),
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w600,
                        color: c.danger,
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  ArukuButton(
                    label: isLogin
                        ? l10n.authLoginTitle
                        : l10n.authSignUpButton,
                    onPressed: _submit,
                  ),
                  const SizedBox(height: 12),
                  _TextLink(
                    label: isLogin
                        ? l10n.authToggleToSignUp
                        : l10n.authToggleToLogin,
                    onTap: _submitting ? null : _toggleMode,
                  ),
                  const SizedBox(height: 24),
                  Row(
                    children: [
                      Expanded(child: Divider(color: c.hairline)),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Text(
                          l10n.authOrDivider,
                          style: jpStyle(
                            size: 12,
                            weight: FontWeight.w600,
                            color: c.ink3,
                          ),
                        ),
                      ),
                      Expanded(child: Divider(color: c.hairline)),
                    ],
                  ),
                  const SizedBox(height: 24),
                  _TextLink(
                    label: l10n.authContinueAsGuest,
                    onTap: _submitting ? null : _continueAsGuest,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
