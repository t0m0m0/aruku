import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

/// 実際の共有シート呼び出し。テストではフェイクを注入して検証する。
typedef ShareInvoker = Future<ShareResult> Function(ShareParams params);

/// 画像添付時に PNG を書き出す一時ディレクトリの供給元。テストでは
/// `Directory.systemTemp` 配下を返して実ファイル書き出しを検証する。
typedef TempDirProvider = Future<Directory> Function();

/// テキスト共有・画像共有を薄くラップするサービス。
///
/// プラットフォーム依存の `SharePlus.instance.share` と `getTemporaryDirectory`
/// を注入可能にし、共有内容（テキスト/添付ファイル）を単体テストで検証できる
/// ようにしている。UI 層はこのサービス経由でのみ共有を呼ぶ。
class ShareService {
  ShareService({ShareInvoker? invoker, TempDirProvider? tempDirProvider})
    : _invoke = invoker ?? SharePlus.instance.share,
      _tempDir = tempDirProvider ?? getTemporaryDirectory;

  final ShareInvoker _invoke;
  final TempDirProvider _tempDir;

  /// ルート概要などのテキストを共有シートへ渡す。
  Future<ShareResult> shareText({required String text, String? subject}) {
    return _invoke(ShareParams(text: text, subject: subject));
  }

  /// PNG バイト列を一時ファイルへ書き出し、[text]（ハッシュタグ等）を添えて共有する。
  ///
  /// byte-backed な `XFile` は一部プラットフォームで名前・パスが欠落するため、
  /// path_provider の一時ディレクトリへ実ファイルを書き出してから共有する。
  Future<ShareResult> shareImagePng({
    required Uint8List bytes,
    required String text,
    String fileName = 'aruku_share.png',
  }) async {
    final dir = await _tempDir();
    final file = File('${dir.path}/$fileName');
    await file.writeAsBytes(bytes, flush: true);
    return _invoke(
      ShareParams(
        text: text,
        files: [XFile(file.path, mimeType: 'image/png')],
      ),
    );
  }
}

final shareServiceProvider = Provider<ShareService>((_) => ShareService());
