import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

/// 全テスト共通の前処理。
///
/// AppNotifier.build() が pedometer のプラットフォームチャネルを listen するが、
/// テスト環境にはプラグイン実装が無い。バインディングを初期化したうえで対象の
/// EventChannel をモックし、listen / cancel が MissingPluginException を投げて
/// 非同期エラーとして漏れるのを防ぐ。setMockStreamHandler は addTearDown を呼ぶため
/// テストコンテキスト内（setUp）で登録する必要がある。
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();

  // テストは決してネットワークへ出ないため、google_fonts のランタイム取得を無効化する。
  // 通常の pump では失敗が握り潰されるが、tester.runAsync 下では実 HTTP が走り
  // フォント取得例外がテストを落とすため、fetch 自体を止めてフォールバックに委ねる。
  GoogleFonts.config.allowRuntimeFetching = false;

  setUp(() {
    // アプリが購読するのは Pedometer.stepCountStream（step_count チャネル）のみ。
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockStreamHandler(
      const EventChannel('step_count'),
      MockStreamHandler.inline(onListen: (_, _) {}, onCancel: (_) {}),
    );
  });

  await testMain();
}
