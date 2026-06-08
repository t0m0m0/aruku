import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/models/app_settings.dart';
import '../../core/state/app_state.dart';
import '../../core/state/settings_provider.dart';
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
                  const _SettingsSection(
                    title: 'アカウント',
                    children: [
                      _LinkRow(
                        label: 'ログイン / アカウント連携',
                        trailing: '準備中',
                        onTap: null,
                      ),
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
}
