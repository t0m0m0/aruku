import 'dart:io';
import 'dart:typed_data';

import 'package:aruku/core/services/share_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';

void main() {
  late Directory tempDir;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('share_service_test');
  });

  tearDown(() async {
    if (tempDir.existsSync()) {
      await tempDir.delete(recursive: true);
    }
  });

  ShareParams? captured;
  ShareService buildService() => ShareService(
    invoker: (params) async {
      captured = params;
      return const ShareResult('ok', ShareResultStatus.success);
    },
    tempDirProvider: () async => tempDir,
  );

  setUp(() => captured = null);

  test('shareText はテキストと件名を ShareParams に載せて共有する', () async {
    final service = buildService();

    final result = await service.shareText(text: '本文', subject: '件名');

    expect(result.status, ShareResultStatus.success);
    expect(captured?.text, '本文');
    expect(captured?.subject, '件名');
    expect(captured?.files ?? const [], isEmpty);
  });

  test('shareImagePng は一時ディレクトリに PNG を書き出して添付共有する', () async {
    final service = buildService();
    final bytes = Uint8List.fromList([1, 2, 3, 4]);

    final result = await service.shareImagePng(
      bytes: bytes,
      text: '完了! #アルク',
      fileName: 'aruku_done.png',
    );

    expect(result.status, ShareResultStatus.success);
    expect(captured?.text, '完了! #アルク');

    final files = captured?.files ?? const [];
    expect(files, hasLength(1));
    expect(files.first.mimeType, 'image/png');

    final written = File(files.first.path);
    expect(written.existsSync(), isTrue);
    expect(await written.readAsBytes(), bytes);
    expect(written.path, endsWith('aruku_done.png'));
  });
}
