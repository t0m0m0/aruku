import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/models/app_settings.dart';
import '../../core/models/auth_user.dart';
import '../../core/state/app_state.dart';
import '../../core/state/auth_provider.dart';
import '../../core/state/settings_provider.dart';
import '../../core/state/sync_provider.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_card.dart';

part 'settings_widgets.dart';

/// 設定画面。単位・通知・既定の時間予算を変更でき、変更は即時に永続化される。
/// 権限とアカウントへの導線も併せて提供する。
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  /// 既定の時間予算として選べる候補（分）。
  static const List<int> _budgetChoices = [30, 45, 60, 90, 120];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final settingsAsync = ref.watch(settingsProvider);
    final settings = settingsAsync.value ?? AppSettings.defaults;
    final settingsNotifier = ref.read(settingsProvider.notifier);
    final user = ref.watch(authProvider).value;

    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => notifier.go(Screen.home),
                    icon: Ic.chevron(
                      size: 20,
                      color: c.ink,
                      dir: ChevronDir.left,
                    ),
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      fixedSize: const Size(40, 40),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '設定',
                    style: jpStyle(
                      size: 20,
                      weight: FontWeight.w800,
                      color: c.ink,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                children: [
                  _SettingsSection(
                    title: '移動',
                    children: [
                      _BudgetRow(
                        value: settings.defaultBudgetMinutes,
                        choices: _budgetChoices,
                        onChanged: settingsNotifier.setDefaultBudget,
                      ),
                      const _RowDivider(),
                      _UnitRow(
                        value: settings.unit,
                        onChanged: settingsNotifier.setUnit,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _SettingsSection(
                    title: '通知',
                    children: [
                      _SwitchRow(
                        label: '通知を受け取る',
                        value: settings.notificationsEnabled,
                        onChanged: settingsNotifier.setNotifications,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  const _SettingsSection(
                    title: '権限',
                    children: [
                      _LinkRow(
                        label: '位置情報・通知の権限',
                        trailing: '端末設定を開く',
                        onTap: openAppSettings,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _SettingsSection(
                    title: 'アカウント',
                    children: [
                      _buildAccountRow(ref, user),
                      if (user != null && !user.isGuest) ...[
                        const _RowDivider(),
                        _buildSyncRow(ref),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 認証状態に応じたアカウント行を作る。
  /// 未ログインはログイン導線、ゲストはログイン（昇格）導線、
  /// メールユーザーはメール表示とログアウトを出す。
  Widget _buildAccountRow(WidgetRef ref, AuthUser? user) {
    final appNotifier = ref.read(appStateProvider.notifier);
    if (user == null) {
      return _LinkRow(
        label: 'ログイン / アカウント作成',
        trailing: '',
        onTap: () => appNotifier.go(Screen.auth),
      );
    }
    if (user.isGuest) {
      return _LinkRow(
        label: 'ゲストとして利用中',
        trailing: 'ログイン',
        onTap: () => appNotifier.go(Screen.auth),
      );
    }
    return _LinkRow(
      label: user.label,
      trailing: 'ログアウト',
      onTap: () => ref.read(authProvider.notifier).signOut(),
    );
  }

  /// クラウド同期の状態表示とトリガー行。同期中は再実行を抑止する。
  Widget _buildSyncRow(WidgetRef ref) {
    final status = ref.watch(syncProvider);
    final syncing = status.phase == SyncPhase.syncing;
    final trailing = switch (status.phase) {
      SyncPhase.syncing => '同期中…',
      SyncPhase.success => '同期済み',
      SyncPhase.error => '失敗・再試行',
      SyncPhase.idle => '今すぐ同期',
    };
    return _LinkRow(
      label: 'クラウド同期',
      trailing: trailing,
      onTap: syncing ? null : () => ref.read(syncProvider.notifier).sync(),
    );
  }
}
