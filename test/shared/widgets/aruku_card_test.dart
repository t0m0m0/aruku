import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(Widget child) => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  theme: ArukuTheme.light(),
  home: Scaffold(body: child),
);

ArukuColors get _c => ArukuColors.wakaba;

BoxDecoration _decorationOf(WidgetTester tester) {
  final container = tester.widget<Container>(
    find.descendant(
      of: find.byType(ArukuCard),
      matching: find.byType(Container),
    ),
  );
  return container.decoration! as BoxDecoration;
}

void main() {
  group('ArukuCard', () {
    testWidgets('renders its child', (tester) async {
      await tester.pumpWidget(_host(const ArukuCard(child: Text('中身'))));
      expect(find.text('中身'), findsOneWidget);
    });

    testWidgets('defaults to paper background with a hairline border', (
      tester,
    ) async {
      await tester.pumpWidget(_host(const ArukuCard(child: SizedBox())));
      final decoration = _decorationOf(tester);
      expect(decoration.color, _c.paper);
      expect(decoration.border, Border.all(color: _c.hairline));
    });

    testWidgets('omits the border when bordered is false', (tester) async {
      await tester.pumpWidget(
        _host(const ArukuCard(bordered: false, child: SizedBox())),
      );
      expect(_decorationOf(tester).border, isNull);
    });

    testWidgets('honors a custom background color', (tester) async {
      await tester.pumpWidget(
        _host(ArukuCard(color: _c.moss50, child: const SizedBox())),
      );
      expect(_decorationOf(tester).color, _c.moss50);
    });

    testWidgets('applies a custom shadow', (tester) async {
      await tester.pumpWidget(
        _host(
          const ArukuCard(
            shadow: [BoxShadow(color: Color(0x11000000), blurRadius: 8)],
            child: SizedBox(),
          ),
        ),
      );
      expect(_decorationOf(tester).boxShadow, isNotEmpty);
    });

    testWidgets('applies padding', (tester) async {
      await tester.pumpWidget(
        _host(const ArukuCard(padding: EdgeInsets.all(12), child: SizedBox())),
      );
      final container = tester.widget<Container>(
        find.descendant(
          of: find.byType(ArukuCard),
          matching: find.byType(Container),
        ),
      );
      expect(container.padding, const EdgeInsets.all(12));
    });
  });
}
