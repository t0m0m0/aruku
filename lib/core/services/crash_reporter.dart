import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

abstract interface class CrashReporter {
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    bool fatal = false,
  });
}

class FirebaseCrashReporter implements CrashReporter {
  const FirebaseCrashReporter();

  @override
  Future<void> recordError(
    Object error,
    StackTrace? stack, {
    String? context,
    bool fatal = false,
  }) async {
    // Web を debug と同じ経路へ落とすのは、firebase_crashlytics が web を
    // プラグイン対象に含めていない（android / ios / macos のみ）ため。Crashlytics を
    // 呼ぶと MissingPluginException になり、呼び出し側は結果を .ignore() で捨てるので
    // 記録も表示も残らない。#359 参照。
    if (!kReleaseMode || kIsWeb) {
      debugPrint('${context ?? 'app'} error: $error');
      return;
    }
    await FirebaseCrashlytics.instance.recordError(
      error,
      stack,
      reason: context,
      fatal: fatal,
      printDetails: false,
    );
  }
}

final crashReporterProvider = Provider<CrashReporter>(
  (ref) => const FirebaseCrashReporter(),
);
