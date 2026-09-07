import 'package:flutter/material.dart';

/// 配下がレイアウトされるまで、フォーカス走査の対象から外す。
///
/// 走査ポリシーの差し替えで済ませないのは、`_findGroups` がグループノード自身を
/// 親グループの既定ポリシーで並べるため——自前ポリシーで守れるのはその内側だけで、
/// ツリー全体がまだレイアウトされていない起動直後の窓は塞げない。候補集合そのものを
/// 空にすれば `FocusNode.rect` は一度も読まれない（#380）。
class FirstFrameFocusGate extends StatefulWidget {
  const FirstFrameFocusGate({required this.child, super.key});

  final Widget child;

  @override
  State<FirstFrameFocusGate> createState() => _FirstFrameFocusGateState();
}

class _FirstFrameFocusGateState extends State<FirstFrameFocusGate> {
  final _node = FocusNode(
    skipTraversal: true,
    canRequestFocus: false,
    debugLabel: 'FirstFrameFocusGate',
  );
  bool _open = false;

  @override
  void initState() {
    super.initState();
    _openWhenLaidOut();
  }

  @override
  void dispose() {
    _node.dispose();
    super.dispose();
  }

  /// `ExcludeFocus` と同じ構成だが、ノードを自前で持つのは開閉を同期的に効かせるため。
  ///
  /// 開けるのに `setState` を使わないのは、リビルドが次のフレームへ回るため。
  /// 祖先の post-frame コールバックは子孫のものより先に走るので、同じフレームで
  /// `requestFocus()` する子孫（`SearchScreen`）が「まだ閉じたゲート」に当たって
  /// 要求を捨てられる。ノードを直接開ければ同フレーム内で効く（PR #381 レビュー）。
  void _openWhenLaidOut() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final renderObject = context.findRenderObject();
      if (renderObject is RenderBox && !renderObject.hasSize) {
        _openWhenLaidOut();
        return;
      }
      _open = true;
      _node.descendantsAreFocusable = true;
    });
  }

  @override
  Widget build(BuildContext context) => Focus(
    focusNode: _node,
    canRequestFocus: false,
    skipTraversal: true,
    includeSemantics: false,
    descendantsAreFocusable: _open,
    child: widget.child,
  );
}
