import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/navigation/share_summary_card.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  theme: ArukuTheme.light(),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  testWidgets('サマリーカードは距離・kcal・区間・ハッシュタグを表示する', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const ShareSummaryCard(
          distanceKm: 5.1,
          kcal: 291,
          from: '新宿三丁目',
          to: '渋谷ヒカリエ',
        ),
      ),
    );
    await tester.pump();

    // 距離とkcal（数値と単位は別Textに分かれている）
    expect(find.text('5.1'), findsOneWidget);
    expect(find.text('km'), findsOneWidget);
    expect(find.text('291'), findsOneWidget);
    expect(find.text('kcal'), findsOneWidget);

    // 区間
    expect(find.text('新宿三丁目'), findsOneWidget);
    expect(find.text('渋谷ヒカリエ'), findsOneWidget);

    // ハッシュタグ
    expect(find.textContaining('#アルク'), findsOneWidget);
  });

  testWidgets('距離は小数第1位で丸めて表示する', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const ShareSummaryCard(distanceKm: 3.04, kcal: 120, from: 'A', to: 'B'),
      ),
    );
    await tester.pump();

    expect(find.text('3.0'), findsOneWidget);
  });
}
