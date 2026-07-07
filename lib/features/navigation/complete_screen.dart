import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/walk_summary.dart';
import '../../core/services/share_service.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import 'share_summary_card.dart';

/// 歩行完了画面。距離・kcal・区間を [ShareSummaryCard] として描画し、
/// タップで PNG 化して SNS などへシェアする。
class CompleteScreen extends ConsumerStatefulWidget {
  const CompleteScreen({super.key});

  @override
  ConsumerState<CompleteScreen> createState() => _CompleteScreenState();
}

class _CompleteScreenState extends ConsumerState<CompleteScreen> {
  final GlobalKey _cardKey = GlobalKey();
  bool _sharing = false;

  /// [ShareSummaryCard] を包む RepaintBoundary を PNG バイト列へ変換する。
  Future<Uint8List?> _captureCardPng() async {
    final boundary =
        _cardKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null) return null;
    final image = await boundary.toImage(pixelRatio: 3);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return data?.buffer.asUint8List();
  }

  Future<void> _share(WalkSummary summary) async {
    if (_sharing) return;
    setState(() => _sharing = true);
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final share = ref.read(shareServiceProvider);
    try {
      final bytes = await _captureCardPng();
      if (bytes == null) {
        // RepaintBoundary 未取得などで画像化に失敗。無言で終わらせず通知する。
        _showError(messenger, l10n);
        return;
      }
      await share.shareImagePng(
        bytes: bytes,
        text: l10n.completeShareText(
          summary.distanceKm.toStringAsFixed(1),
          summary.kcal,
        ),
      );
    } catch (_) {
      // share_plus の PlatformException 等。unawaited 実行のため catch しないと
      // 未捕捉の非同期例外になる。失敗はユーザーに軽く通知する。
      _showError(messenger, l10n);
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  void _showError(ScaffoldMessengerState messenger, AppLocalizations l10n) {
    messenger.showSnackBar(SnackBar(content: Text(l10n.shareErrorMessage)));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final summary = ref.watch(appStateProvider.select((s) => s.walkSummary));
    final notifier = ref.read(appStateProvider.notifier);

    // SnackBar（共有失敗通知）を表示できるよう Scaffold を土台にする。
    return Scaffold(
      backgroundColor: c.ivory,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
          child: Column(
            children: [
              const Spacer(),
              if (summary != null)
                RepaintBoundary(
                  key: _cardKey,
                  child: ShareSummaryCard(
                    distanceKm: summary.distanceKm,
                    kcal: summary.kcal,
                    from: summary.from,
                    to: summary.to,
                  ),
                ),
              const Spacer(),
              if (summary != null)
                ArukuButton(
                  key: const Key('complete-share-button'),
                  label: l10n.completeShareButton,
                  onPressed: () => unawaited(_share(summary)),
                  icon: Ic.share(size: 18, color: c.ivory),
                  iconGap: 8,
                  textStyle: jpStyle(
                    size: 16,
                    weight: FontWeight.w800,
                    color: c.ivory,
                  ),
                ),
              const SizedBox(height: 10),
              TextButton(
                key: const Key('complete-home-button'),
                onPressed: () => notifier.go(Screen.home),
                child: Text(
                  l10n.completeHomeButton,
                  style: jpStyle(
                    size: 14,
                    weight: FontWeight.w700,
                    color: c.ink2,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
