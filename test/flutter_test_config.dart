import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 全テスト共通の前処理。
///
/// AppNotifier.build() が pedometer のプラットフォームチャネルを listen するが、
/// テスト環境にはプラグイン実装が無い。バインディングを初期化したうえで対象の
/// EventChannel をモックし、listen / cancel が MissingPluginException を投げて
/// 非同期エラーとして漏れるのを防ぐ。setMockStreamHandler は addTearDown を呼ぶため
/// テストコンテキスト内（setUp）で登録する必要がある。
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final channel in const ['step_count', 'pedestrian_status']) {
      messenger.setMockStreamHandler(
        EventChannel(channel),
        MockStreamHandler.inline(onListen: (_, _) {}, onCancel: (_) {}),
      );
    }
  });

  await testMain();
}
