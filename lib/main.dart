import 'dart:io' show Platform;

import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;

import 'core/config/app_config.dart';
import 'core/navigation/app_router.dart';
import 'core/services/crash_reporter.dart';
import 'core/services/health_service.dart';
import 'core/services/healthkit_service.dart';
import 'core/services/local_notification_service.dart';
import 'core/services/notification_service.dart';
import 'core/services/onboarding_repository.dart';
import 'core/services/recents_repository.dart';
import 'core/state/app_state.dart';
import 'core/theme/aruku_theme.dart';
import 'firebase_options.dart';
import 'l10n/app_localizations.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  _assertFirebaseKeyPresent();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await _activateAppCheck();
  const crashReporter = FirebaseCrashReporter();
  if (kReleaseMode) {
    _installCrashHandlers(crashReporter);
  }
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
    ),
  );
  // オンボーディングのチラつきを避けるため、初期画面の判定に使う完了フラグを
  // 起動前に同期的に読めるよう SharedPreferences を先読みして注入する。
  final prefs = await SharedPreferences.getInstance();
  // ローカル通知の zonedSchedule はタイムゾーン DB を必要とする。DB を初期化し、
  // 予約時刻の表現に使うローカルゾーンを設定する。本アプリは日本向けのため
  // Asia/Tokyo を用いる。実際の発火時刻は端末ローカルの壁時計時刻に従う
  // （予約は絶対時刻として解釈されるため、このゾーン設定は発火時刻を変えない）。
  tz_data.initializeTimeZones();
  tz.setLocalLocation(tz.getLocation('Asia/Tokyo'));
  runApp(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        crashReporterProvider.overrideWithValue(crashReporter),
        onboardingCompletedProvider.overrideWithValue(
          OnboardingRepository(prefs).isCompleted(),
        ),
        // HealthKit は iOS 専用。iOS でのみ実体を注入し、他プラットフォームは
        // 既定の NoopHealthService（無害な no-op）のままにする。
        if (Platform.isIOS)
          healthServiceProvider.overrideWithValue(HealthKitService()),
        // ローカル通知は iOS / Android の実機のみ。他は既定の
        // NoopNotificationService（無害な no-op）のままにする。
        if (Platform.isIOS || Platform.isAndroid)
          notificationServiceProvider.overrideWithValue(
            LocalNotificationService(),
          ),
      ],
      child: const ArukuApp(),
    ),
  );
}

void _installCrashHandlers(CrashReporter crashReporter) {
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    crashReporter
        .recordError(
          details.exception,
          details.stack,
          context: 'flutter.framework',
          fatal: true,
        )
        .ignore();
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    crashReporter
        .recordError(error, stack, context: 'platform.unhandled', fatal: true)
        .ignore();
    return true;
  };
}

// API キーは --dart-define-from-file=dart_defines.json で注入する。渡し忘れると
// String.fromEnvironment は空文字を返し、Firebase 初期化が分かりにくく失敗する。
// debug ビルドのみ早期に検出してセットアップ漏れを明示する（release では assert
// は除去され、本番ビルドは CI 等で確実にキーを注入する前提）。
void _assertFirebaseKeyPresent() {
  assert(() {
    if (DefaultFirebaseOptions.currentPlatform.apiKey.isEmpty) {
      throw StateError(
        'Firebase API キーが空です。'
        '--dart-define-from-file=dart_defines.json を付けて起動してください'
        '（dart_defines.example.json 参照）。',
      );
    }
    return true;
  }());
}

// App Check で Cloud Functions プロキシ（課金 API）への未認証アクセスを遮断する。
// debug ビルドは debug プロバイダを使い、Firebase Console でデバッグトークンを
// 登録して開発する。
Future<void> _activateAppCheck() {
  if (kDebugMode) {
    const token = AppConfig.appCheckDebugToken;
    return FirebaseAppCheck.instance.activate(
      providerAndroid: AndroidDebugProvider(
        debugToken: token.isEmpty ? null : token,
      ),
      providerApple: AppleDebugProvider(
        debugToken: token.isEmpty ? null : token,
      ),
    );
  }
  return FirebaseAppCheck.instance.activate(
    providerAndroid: const AndroidPlayIntegrityProvider(),
    providerApple: const AppleAppAttestProvider(),
  );
}

class ArukuApp extends ConsumerStatefulWidget {
  const ArukuApp({super.key});

  @override
  ConsumerState<ArukuApp> createState() => _ArukuAppState();
}

class _ArukuAppState extends ConsumerState<ArukuApp> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    // フォアグラウンド復帰で「今すぐ出発」の時刻を再検証する。長時間バックグラウンド
    // 後に古い出発時刻のまま経路を開始できる問題を防ぐ（#264）。
    _lifecycle = AppLifecycleListener(
      onResume: () => ref.read(appStateProvider.notifier).onAppResumed(),
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 画面遷移は go_router が権威。ルートツリー・戻る挙動・遷移アニメは
    // すべて goRouterProvider（lib/core/navigation/app_router.dart）に集約。
    return MaterialApp.router(
      onGenerateTitle: (context) => AppLocalizations.of(context).appTitle,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      debugShowCheckedModeBanner: false,
      theme: ArukuTheme.light(),
      routerConfig: ref.watch(goRouterProvider),
    );
  }
}
