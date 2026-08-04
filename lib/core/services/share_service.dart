import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

/// 実際の共有シート呼び出し。テストではフェイクを注入して検証する。
typedef ShareInvoker = Future<ShareResult> Function(ShareParams params);

/// テキスト共有を薄くラップするサービス。
///
/// プラットフォーム依存の `SharePlus.instance.share` を注入可能にし、共有内容を
/// 単体テストで検証できるようにしている。UI 層はこのサービス経由でのみ共有を呼ぶ。
class ShareService {
  ShareService({ShareInvoker? invoker})
    : _invoke = invoker ?? SharePlus.instance.share;

  final ShareInvoker _invoke;

  /// ルート概要などのテキストを共有シートへ渡す。
  Future<ShareResult> shareText({required String text, String? subject}) {
    return _invoke(ShareParams(text: text, subject: subject));
  }
}

final shareServiceProvider = Provider<ShareService>((_) => ShareService());
