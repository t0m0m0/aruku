import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aruku/main.dart';

void main() {
  testWidgets('App boots into Onboarding', (WidgetTester tester) async {
    await tester.pumpWidget(const ProviderScope(child: ArukuApp()));
    await tester.pump();
    expect(find.text('はじめる'), findsOneWidget);
  });
}
