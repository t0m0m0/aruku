import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_button.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(Widget child) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  theme: ArukuTheme.light(),
  home: Scaffold(body: child),
);

ArukuColors get _c => ArukuColors.wakaba;

void main() {
  group('ArukuButton', () {
    testWidgets('renders the label', (tester) async {
      await tester.pumpWidget(
        _host(ArukuButton(label: 'ルートを検索', onPressed: () {})),
      );
      expect(find.text('ルートを検索'), findsOneWidget);
    });

    testWidgets('invokes onPressed when tapped', (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        _host(ArukuButton(label: '次へ', onPressed: () => taps++)),
      );
      await tester.tap(find.byType(ArukuButton));
      expect(taps, 1);
    });

    testWidgets('renders a leading icon when provided', (tester) async {
      await tester.pumpWidget(
        _host(
          ArukuButton(
            label: '検索',
            icon: const Icon(Icons.search),
            onPressed: () {},
          ),
        ),
      );
      expect(find.byIcon(Icons.search), findsOneWidget);
    });

    testWidgets('filled variant uses moss600 background by default', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(ArukuButton(label: 'OK', onPressed: () {})),
      );
      final material = tester.widget<Material>(
        find
            .descendant(
              of: find.byType(ArukuButton),
              matching: find.byType(Material),
            )
            .first,
      );
      expect(material.color, _c.moss600);
    });

    testWidgets('filled variant honors a custom background color', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          ArukuButton(
            label: 'OK',
            backgroundColor: _c.moss500,
            onPressed: () {},
          ),
        ),
      );
      final material = tester.widget<Material>(
        find
            .descendant(
              of: find.byType(ArukuButton),
              matching: find.byType(Material),
            )
            .first,
      );
      expect(material.color, _c.moss500);
    });

    testWidgets('outlined variant draws a hairline border', (tester) async {
      await tester.pumpWidget(
        _host(
          ArukuButton(
            label: '戻る',
            variant: ArukuButtonVariant.outlined,
            onPressed: () {},
          ),
        ),
      );
      final ink = tester.widget<Ink>(
        find.descendant(
          of: find.byType(ArukuButton),
          matching: find.byType(Ink),
        ),
      );
      final decoration = ink.decoration! as BoxDecoration;
      expect(decoration.border, isNotNull);
    });

    testWidgets('uses a custom iconGap between icon and label', (tester) async {
      await tester.pumpWidget(
        _host(
          ArukuButton(
            label: '歩く',
            icon: const Icon(Icons.directions_walk),
            iconGap: 8,
            onPressed: () {},
          ),
        ),
      );
      final row = tester.widget<Row>(
        find.descendant(
          of: find.byType(ArukuButton),
          matching: find.byType(Row),
        ),
      );
      final gap = row.children[1] as SizedBox;
      expect(gap.width, 8);
    });

    testWidgets('applies a custom shadow', (tester) async {
      await tester.pumpWidget(
        _host(
          ArukuButton(
            label: '影付き',
            shadow: const [BoxShadow(color: Color(0x11000000), blurRadius: 8)],
            onPressed: () {},
          ),
        ),
      );
      final ink = tester.widget<Ink>(
        find.descendant(
          of: find.byType(ArukuButton),
          matching: find.byType(Ink),
        ),
      );
      final decoration = ink.decoration! as BoxDecoration;
      expect(decoration.boxShadow, isNotEmpty);
    });
  });
}
