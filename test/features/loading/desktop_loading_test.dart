import 'package:aruku/core/config/layout_breakpoints.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/loading/loading_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_map.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// ローディングは幅で分岐しない。全面地図＋中央寄せという現行の構成が、
/// そのままデスクトップのデザインと一致するため。分岐を足す変更が入ったとき、
/// 「両側で同じ」という前提の崩れをここが知らせる。
Future<void> _pump(WidgetTester tester, {required bool desktop}) async {
  tester.view.physicalSize = Size(desktop ? 1280 : 800, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [isDesktopLayoutProvider.overrideWithValue(desktop)],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: const LoadingScreen(),
      ),
    ),
  );
  await tester.pump();
}

const _message = '歩ける道を、探しています';

void main() {
  testWidgets('デスクトップ幅では地図がビューポート全面を占める', (tester) async {
    await _pump(tester, desktop: true);

    expect(tester.getSize(find.byType(ArukuMap)), const Size(1280, 900));
  });

  testWidgets('デスクトップ幅でも中央の進捗表示は画面中央に置かれる', (tester) async {
    await _pump(tester, desktop: true);

    expect(tester.getRect(find.text(_message)).center.dx, closeTo(640, 1));
  });

  testWidgets('モバイル幅でも同じ構成のまま', (tester) async {
    await _pump(tester, desktop: false);

    expect(tester.getSize(find.byType(ArukuMap)), const Size(800, 900));
    expect(tester.getRect(find.text(_message)).center.dx, closeTo(400, 1));
  });
}
