import 'package:aruku/core/config/layout_breakpoints.dart';
import 'package:aruku/shared/widgets/responsive_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// [isDesktopLayoutProvider] の解決値を [tester] から読めるようにする。
Widget _probe(void Function(bool) onValue) {
  return Consumer(
    builder: (context, ref, _) {
      onValue(ref.watch(isDesktopLayoutProvider));
      return const SizedBox.shrink();
    },
  );
}

Future<bool> _resolveAt(WidgetTester tester, double width) async {
  var resolved = false;
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(size: Size(width, 900)),
      child: ResponsiveScope(child: _probe((v) => resolved = v)),
    ),
  );
  return resolved;
}

void main() {
  group('isDesktopWidth', () {
    test('820px 未満はモバイルレイアウト', () {
      expect(isDesktopWidth(819), isFalse);
    });

    test('820px ちょうどからデスクトップレイアウト', () {
      expect(isDesktopWidth(820), isTrue);
    });

    // 幅は「まだ測れていない」ことを負値や 0 で表現しうる。境界の外側でも
    // モバイルへ倒れることを固定し、未確定時にデスクトップが露出しないようにする。
    test('ゼロ幅・負値はモバイルへ倒す', () {
      expect(isDesktopWidth(0), isFalse);
      expect(isDesktopWidth(-1), isFalse);
    });
  });

  group('isDesktopLayoutProvider', () {
    testWidgets('819px ではモバイルレイアウトとして解決する', (tester) async {
      expect(await _resolveAt(tester, 819), isFalse);
    });

    testWidgets('820px ではデスクトップレイアウトとして解決する', (tester) async {
      expect(await _resolveAt(tester, 820), isTrue);
    });

    // 既定をデスクトップにすると、ResponsiveScope を通らない経路（既存の
    // widget test や将来の別 entry point）が本番に無い UI を出す。既定が
    // モバイルなら、通らない経路は現行 UI に落ちるだけで退行しない。
    testWidgets('ResponsiveScope を通さない場合はモバイルとして解決する', (tester) async {
      var resolved = true;
      await tester.pumpWidget(
        ProviderScope(child: _probe((v) => resolved = v)),
      );
      expect(resolved, isFalse);
    });

    testWidgets('ウィンドウ幅の変化に追従する', (tester) async {
      final seen = <bool>[];
      Widget appAt(double width) => MediaQuery(
        data: MediaQueryData(size: Size(width, 900)),
        child: ResponsiveScope(child: _probe(seen.add)),
      );

      await tester.pumpWidget(appAt(400));
      await tester.pumpWidget(appAt(1280));
      await tester.pumpWidget(appAt(500));

      expect(seen.first, isFalse);
      expect(seen, contains(true));
      expect(seen.last, isFalse);
    });
  });
}
