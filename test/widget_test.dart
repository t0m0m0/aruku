import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aruku/main.dart';

void main() {
  testWidgets('App boots into Onboarding', (WidgetTester tester) async {
    await tester.pumpWidget(const ProviderScope(child: ArukuApp()));
    await tester.pump();
    expect(find.byKey(const Key('onboard-page-0')), findsOneWidget);
    expect(find.text('次へ'), findsOneWidget);
  });
}
