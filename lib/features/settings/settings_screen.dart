import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/constants/app_constants.dart';
import '../../core/models/app_settings.dart';
import '../../core/services/url_launcher.dart';
import '../../core/state/app_state.dart';
import '../../core/state/settings_provider.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/km_format.dart';
import '../../shared/widgets/aruku_card.dart';

part 'settings_widgets.dart';

/// 設定画面。通知を変更でき、変更は即時に永続化される。
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final notifier = ref.read(appStateProvider.notifier);
    final settingsAsync = ref.watch(settingsProvider);
    final settings = settingsAsync.value ?? AppSettings.defaults;
    final settingsNotifier = ref.read(settingsProvider.notifier);
    final launcher = ref.read(urlLauncherProvider);

    // 保存失敗時はトグルが直前値へ自動的に戻る（state を更新しない方針）。
    // それだけでは変化が無かったように見えるため、SnackBar で失敗を知らせる。
    Future<void> guardSave(Future<void> Function() save) async {
      final messenger = ScaffoldMessenger.of(context);
      try {
        await save();
      } catch (_) {
        messenger.showSnackBar(
          SnackBar(content: Text(l10n.settingsSaveFailed)),
        );
      }
    }

    // 端末にブラウザが無い等で起動が false／例外になっても無音で失敗しないよう、
    // 到達できなかったことを SnackBar で知らせる。
    Future<void> openExternal(Uri url) async {
      final messenger = ScaffoldMessenger.of(context);
      try {
        final opened = await launcher(url);
        if (!opened) {
          messenger.showSnackBar(
            SnackBar(content: Text(l10n.settingsLinkOpenFailed)),
          );
        }
      } catch (_) {
        messenger.showSnackBar(
          SnackBar(content: Text(l10n.settingsLinkOpenFailed)),
        );
      }
    }

    // Scaffold にするのは SnackBar（ScaffoldMessenger）を提示できる祖先が
    // 必要なため。従来の Material 直下では showSnackBar が assert で落ちる。
    return Scaffold(
      backgroundColor: c.ivory,
      body: SafeArea(
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
                    tooltip: l10n.commonBack,
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
                    l10n.settingsTitle,
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
                    title: l10n.settingsNotificationsSection,
                    children: [
                      _SwitchRow(
                        switchKey: const Key('switch_notifications'),
                        label: l10n.settingsReceiveNotifications,
                        value: settings.notificationsEnabled,
                        onChanged: (v) => guardSave(
                          () => settingsNotifier.setNotifications(v),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _SettingsSection(
                    title: l10n.settingsHealthKitSection,
                    children: [
                      _SwitchRow(
                        switchKey: const Key('switch_healthkit'),
                        label: l10n.settingsHealthKitEnable,
                        value: settings.healthKitEnabled,
                        onChanged: (v) => guardSave(
                          () => settingsNotifier.setHealthKitEnabled(v),
                        ),
                      ),
                      _SettingsNote(text: l10n.settingsHealthKitDescription),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _SettingsSection(
                    title: l10n.settingsWeeklyGoalSection,
                    children: [
                      _GoalPresetRow(
                        label: l10n.settingsWeeklyGoalLabel,
                        selectedKm: settings.weeklyGoalKm,
                        onSelected: (km) => guardSave(
                          () => settingsNotifier.setWeeklyGoalKm(km),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _SettingsSection(
                    title: l10n.settingsPermissionsSection,
                    children: [
                      _LinkRow(
                        label: l10n.settingsLocationNotificationPermission,
                        trailing: l10n.settingsOpenDeviceSettings,
                        onTap: openAppSettings,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _SettingsSection(
                    title: l10n.settingsLegalSection,
                    children: [
                      _LinkRow(
                        key: const Key('link_terms'),
                        label: l10n.settingsTermsOfService,
                        onTap: () => openExternal(
                          Uri.parse(AppConstants.termsOfServiceUrl),
                        ),
                      ),
                      _LinkRow(
                        key: const Key('link_privacy'),
                        label: l10n.settingsPrivacyPolicy,
                        onTap: () => openExternal(
                          Uri.parse(AppConstants.privacyPolicyUrl),
                        ),
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
