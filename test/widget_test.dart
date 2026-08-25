import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/main.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('App boots into Home', (WidgetTester tester) async {
    await tester.pumpWidget(const ProviderScope(child: ArukuApp()));
    await tester.pump();
    expect(find.byType(HomeScreen), findsOneWidget);
  });
}
