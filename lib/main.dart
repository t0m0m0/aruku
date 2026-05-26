import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/state/app_state.dart';
import 'core/theme/aruku_theme.dart';
import 'features/error/error_screen.dart';
import 'features/home/home_screen.dart';
import 'features/loading/loading_screen.dart';
import 'features/navigation/nav_screen.dart';
import 'features/onboarding/onboarding_screen.dart';
import 'features/result/result_screen.dart';
import 'features/search/search_screen.dart';
import 'firebase_options.dart';

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
  runApp(const ProviderScope(child: ArukuApp()));
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
    return FirebaseAppCheck.instance.activate(
      providerAndroid: const AndroidDebugProvider(),
      providerApple: const AppleDebugProvider(),
    );
  }
  return FirebaseAppCheck.instance.activate(
    providerAndroid: const AndroidPlayIntegrityProvider(),
    providerApple: const AppleAppAttestProvider(),
  );
}

class ArukuApp extends StatelessWidget {
  const ArukuApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'あるく',
      debugShowCheckedModeBanner: false,
      theme: ArukuTheme.light(),
      home: const _Root(),
    );
  }
}

class _Root extends ConsumerWidget {
  const _Root();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(appStateProvider);
    final screen = state.screen;

    final Widget body = switch (screen) {
      Screen.onboarding => const OnboardingScreen(),
      Screen.home => const HomeScreen(),
      Screen.search => const SearchScreen(),
      Screen.searchOrigin => const SearchScreen(mode: SearchMode.origin),
      Screen.loading => const LoadingScreen(),
      Screen.result => const ResultScreen(),
      Screen.nav => const NavScreen(),
      Screen.error => const ErrorScreen(),
    };

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (screen == Screen.search ||
            screen == Screen.searchOrigin ||
            screen == Screen.result ||
            screen == Screen.nav ||
            screen == Screen.error) {
          ref.read(appStateProvider.notifier).go(Screen.home);
        }
      },
      child: Stack(
        fit: StackFit.expand,
        children: [
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            switchInCurve: Curves.easeOutCubic,
            layoutBuilder: (currentChild, previousChildren) {
              return Stack(
                fit: StackFit.expand,
                alignment: Alignment.center,
                children: <Widget>[
                  ...previousChildren.map((w) => Positioned.fill(child: w)),
                  if (currentChild != null)
                    Positioned.fill(child: currentChild),
                ],
              );
            },
            transitionBuilder: (child, anim) {
              return FadeTransition(
                opacity: anim,
                child: SlideTransition(
                  position: Tween<Offset>(
                    begin: const Offset(0, 0.02),
                    end: Offset.zero,
                  ).animate(anim),
                  child: child,
                ),
              );
            },
            child: KeyedSubtree(key: ValueKey(screen), child: body),
          ),
        ],
      ),
    );
  }
}
