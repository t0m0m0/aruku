import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/shared/widgets/aruku_button.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(
    theme: ArukuTheme.light(),
    home: Scaffold(body: child),
  );

  testWidgets('ArukuButton はラベル付きのボタンとして 1 ノードで公開される', (tester) async {
    final handle = tester.ensureSemantics();
    var tapped = false;

    await tester.pumpWidget(
      wrap(ArukuButton(label: '検索する', onPressed: () => tapped = true)),
    );

    // MergeSemantics によりラベル・ボタン役割・タップ操作が同一ノードへ統合される。
    expect(
      tester.getSemantics(find.text('検索する')),
      containsSemantics(label: '検索する', isButton: true, hasTapAction: true),
    );

    await tester.tap(find.byType(ArukuButton));
    expect(tapped, isTrue);

    handle.dispose();
  });
}
