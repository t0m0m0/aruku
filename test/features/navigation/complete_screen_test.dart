import 'dart:io';

import 'package:aruku/core/models/walk_summary.dart';
import 'package:aruku/core/services/share_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/navigation/complete_screen.dart';
import 'package:aruku/features/navigation/share_summary_card.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';

/// build() で位置取得を起動せず、preset した状態を返すテスト用 Notifier。
class _PresetNotifier extends AppNotifier {
  _PresetNotifier(this._initial);
  final AppState _initial;

  @override
  AppState build() => _initial;
}

const _summary = WalkSummary(
  distanceKm: 5.1,
  kcal: 291,
  from: '新宿三丁目',
  to: '渋谷ヒカリエ',
);

AppState _completeState() =>
    AppState.initial.copyWith(screen: Screen.complete, walkSummary: _summary);

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const CompleteScreen(),
  ),
);

void main() {
  testWidgets('完了画面はサマリーカードに距離・kcal・区間を表示する', (tester) async {
    final container = ProviderContainer(
      overrides: [
        appStateProvider.overrideWith(() => _PresetNotifier(_completeState())),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.byType(ShareSummaryCard), findsOneWidget);
    expect(find.text('5.1'), findsOneWidget);
    expect(find.text('291'), findsOneWidget);
    expect(find.text('新宿三丁目'), findsOneWidget);
    expect(find.text('渋谷ヒカリエ'), findsOneWidget);
  });

  testWidgets('「ホームに戻る」でホーム画面へ遷移する', (tester) async {
    final notifier = _PresetNotifier(_completeState());
    final container = ProviderContainer(
      overrides: [appStateProvider.overrideWith(() => notifier)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.byKey(const Key('complete-home-button')));
    await tester.pump();

    expect(notifier.state.screen, Screen.home);
  });

  testWidgets('シェアボタンで画像をハッシュタグ付きで共有する', (tester) async {
    ShareParams? captured;
    final fakeShare = ShareService(
      invoker: (params) async {
        captured = params;
        return const ShareResult('ok', ShareResultStatus.success);
      },
      tempDirProvider: () async =>
          Directory.systemTemp.createTemp('complete_share'),
    );

    final container = ProviderContainer(
      overrides: [
        appStateProvider.overrideWith(() => _PresetNotifier(_completeState())),
        shareServiceProvider.overrideWithValue(fakeShare),
      ],
    );
    addTearDown(container.dispose);

    await tester.runAsync(() async {
      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.byKey(const Key('complete-share-button')));
      // 画像キャプチャ(toImage/png)＋一時ファイル書き出しは実時間の非同期処理。
      // fire-and-forget の共有 Future が解決するまで実時間で待つ。
      for (var i = 0; i < 20 && captured == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        await tester.pump();
      }
    });

    expect(captured, isNotNull);
    expect(captured!.files, isNotEmpty);
    expect(captured!.text, contains('#アルク'));
    expect(captured!.text, contains('5.1'));
  });

  testWidgets('共有が失敗しても未捕捉例外にせず、エラーを通知する', (tester) async {
    var called = false;
    final throwingShare = ShareService(
      invoker: (_) async {
        called = true;
        throw Exception('share failed');
      },
      tempDirProvider: () async =>
          Directory.systemTemp.createTemp('complete_share_err'),
    );

    final container = ProviderContainer(
      overrides: [
        appStateProvider.overrideWith(() => _PresetNotifier(_completeState())),
        shareServiceProvider.overrideWithValue(throwingShare),
      ],
    );
    addTearDown(container.dispose);

    await tester.runAsync(() async {
      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.byKey(const Key('complete-share-button')));
      for (var i = 0; i < 20 && !called; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        await tester.pump();
      }
    });
    await tester.pump(); // SnackBar を描画

    expect(called, isTrue);
    // 共有失敗は catch され、未捕捉の非同期例外にならない。
    expect(tester.takeException(), isNull);
    expect(find.text('共有できませんでした。もう一度お試しください'), findsOneWidget);
  });
}
