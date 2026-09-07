import 'package:aruku/shared/widgets/first_frame_focus_gate.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const anchor = Key('anchor');

  Widget wrap(Widget child) => MaterialApp(home: child);

  // 候補が 1 つだけだと ReadingOrderTraversalPolicy.sort が早期 return して rect を
  // 読まない。レイアウト済みのノードを並べて、並べ替えが実際に走る形にする。
  Widget unlaidAmongLaidOut() => const Column(
    children: [
      Focus(child: SizedBox(key: anchor)),
      _NeverLaysOutChild(child: Focus(child: SizedBox())),
    ],
  );

  FocusNode? findFirstFocus(WidgetTester tester) {
    final context = tester.element(find.byKey(anchor));
    return FocusTraversalGroup.of(
      context,
    ).findFirstFocus(FocusScope.of(context), ignoreCurrentFocus: true);
  }

  final Matcher throwsNotLaidOut = throwsA(
    isA<Object>().having(
      (e) => e.toString(),
      'toString',
      contains('RenderBox was not laid out'),
    ),
  );

  testWidgets('初回フレームでは、レイアウト前のノードを走査対象にしない', (tester) async {
    // レイアウトまで進めないのが、ゲートが閉じている窓そのもの。本番では
    // ウィジェットツリーの構築後・最初のレイアウト前にビューがフォーカスを得る。
    await tester.pumpWidget(
      wrap(FirstFrameFocusGate(child: unlaidAmongLaidOut())),
      phase: EnginePhase.build,
    );

    expect(() => findFirstFocus(tester), returnsNormally);
  });

  testWidgets('ゲートが無ければ、同じツリーで走査が落ちる', (tester) async {
    await tester.pumpWidget(
      wrap(unlaidAmongLaidOut()),
      phase: EnginePhase.build,
    );

    expect(() => findFirstFocus(tester), throwsNotLaidOut);
  });

  testWidgets('ゲート中に要求されたフォーカスを取りこぼさない', (tester) async {
    final node = FocusNode();
    addTearDown(node.dispose);

    await tester.pumpWidget(
      wrap(FirstFrameFocusGate(child: _RequestsFocusOnFirstFrame(node: node))),
    );
    await tester.pumpAndSettle();

    expect(node.hasFocus, isTrue);
  });

  testWidgets('レイアウト前は閉じ、レイアウト後に開く', (tester) async {
    final node = FocusNode();
    addTearDown(node.dispose);

    await tester.pumpWidget(
      wrap(
        FirstFrameFocusGate(
          child: Focus(
            focusNode: node,
            child: const SizedBox(key: anchor),
          ),
        ),
      ),
      phase: EnginePhase.build,
    );
    expect(node.canRequestFocus, isFalse);

    await tester.pump();

    expect(node.canRequestFocus, isTrue);
    expect(findFirstFocus(tester), isNotNull);
  });
}

/// 子をレイアウトしない RenderBox。
///
/// `Offstage` を使わないのは、`RenderOffstage.performLayout` が offstage でも
/// `child?.layout(constraints)` を呼び、子がサイズを持ってしまうため。走査が読む
/// `FocusNode.rect` を落とすには、子が `hasSize == false` のままである必要がある。
class _NeverLaysOutChild extends SingleChildRenderObjectWidget {
  const _NeverLaysOutChild({super.child});

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderNeverLaysOutChild();
}

class _RenderNeverLaysOutChild extends RenderBox
    with RenderObjectWithChildMixin<RenderBox> {
  @override
  void performLayout() => size = constraints.smallest;

  @override
  void paint(PaintingContext context, Offset offset) {}

  @override
  void visitChildrenForSemantics(RenderObjectVisitor visitor) {}
}

/// 初回フレームの post-frame でフォーカスを要求する。SearchScreen と同じ形
/// （lib/features/search/search_screen.dart）。
class _RequestsFocusOnFirstFrame extends StatefulWidget {
  const _RequestsFocusOnFirstFrame({required this.node});

  final FocusNode node;

  @override
  State<_RequestsFocusOnFirstFrame> createState() =>
      _RequestsFocusOnFirstFrameState();
}

class _RequestsFocusOnFirstFrameState
    extends State<_RequestsFocusOnFirstFrame> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => widget.node.requestFocus(),
    );
  }

  @override
  Widget build(BuildContext context) => Focus(
    focusNode: widget.node,
    child: const SizedBox(key: Key('anchor')),
  );
}
