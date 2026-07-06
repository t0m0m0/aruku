import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/config/app_config.dart';
import 'core/navigation/app_router.dart';
import 'core/services/onboarding_repository.dart';
import 'core/services/recents_repository.dart';
import 'core/theme/aruku_theme.dart';
import 'firebase_options.dart';
import 'l10n/app_localizations.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  _assertFirebaseKeyPresent();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  await _activateAppCheck();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
    ),
  );
  // オンボーディングのチラつきを避けるため、初期画面の判定に使う完了フラグを
  // 起動前に同期的に読めるよう SharedPreferences を先読みして注入する。
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        onboardingCompletedProvider.overrideWithValue(
          OnboardingRepository(prefs).isCompleted(),
        ),
      ],
      child: const ArukuApp(),
    ),
  );
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

class ArukuApp extends ConsumerWidget {
  const ArukuApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
