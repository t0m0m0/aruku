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
    if (!kReleaseMode) {
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
