import 'package:aruku/core/services/share_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';

void main() {
  ShareParams? captured;

  ShareService buildService() => ShareService(
    invoker: (params) async {
      captured = params;
      return const ShareResult('ok', ShareResultStatus.success);
    },
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
}
