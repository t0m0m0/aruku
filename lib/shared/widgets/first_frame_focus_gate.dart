import 'package:flutter/material.dart';

/// 初回フレームのレイアウトが終わるまで、配下をフォーカス走査の対象から外す。
///
/// 走査ポリシーの差し替えで済ませないのは、`_findGroups` がグループノード自身を
/// 親グループの既定ポリシーで並べるため——自前ポリシーで守れるのはその内側だけで、
/// ツリー全体がまだレイアウトされていない起動直後の窓は塞げない。`ExcludeFocus`
/// なら候補集合そのものが空になり、`FocusNode.rect` が一度も読まれない（#380）。
class FirstFrameFocusGate extends StatefulWidget {
  const FirstFrameFocusGate({required this.child, super.key});

  final Widget child;

  @override
  State<FirstFrameFocusGate> createState() => _FirstFrameFocusGateState();
}

class _FirstFrameFocusGateState extends State<FirstFrameFocusGate> {
  bool _laidOut = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      setState(() => _laidOut = true);
    });
  }

  @override
  Widget build(BuildContext context) =>
      ExcludeFocus(excluding: !_laidOut, child: widget.child);
}
