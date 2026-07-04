import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/auth_screen.dart';
import '../../features/error/error_screen.dart';
import '../../features/home/home_screen.dart';
import '../../features/loading/loading_screen.dart';
import '../../features/navigation/nav_screen.dart';
import '../../features/onboarding/onboarding_screen.dart';
import '../../features/result/result_screen.dart';
import '../../features/search/search_screen.dart';
import '../../features/settings/settings_screen.dart';
import '../state/app_state.dart';
import 'screen_paths.dart';

/// 旧 AnimatedSwitcher（main.dart の _Root）と同じ見た目の遷移。
/// fade + ごく小さな上方向スライドを 220ms で再生する。
const _transitionDuration = Duration(milliseconds: 220);

CustomTransitionPage<void> _page(GoRouterState state, Widget child) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    transitionDuration: _transitionDuration,
    reverseTransitionDuration: _transitionDuration,
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.02),
            end: Offset.zero,
          ).animate(curved),
          child: child,
        ),
      );
    },
    child: child,
  );
}

/// アプリ全体のルーター。current route の権威は GoRouter が持ち、
/// [AppState.screen] はそのミラー（同期は後続コミットで配線）。
///
/// ネスト構造は旧 _Root の PopScope 手動分岐を実 pop で再現する:
/// auth→settings、settings/search/result/nav/error→home。
/// home・onboarding・loading は PopScope(canPop: false) で back を無効化し、
/// 「back でアプリが終了しない」現行仕様を維持する。
final goRouterProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(
    initialLocation: ref.read(appStateProvider).screen.path,
    // enum 切替時代は state なしで result 等に到達できなかったが、deep link
    // では可能になる。表示前提データを欠く場合は home へ跳ね返す。
    redirect: (context, state) {
      final app = ref.read(appStateProvider);
      final missingPrerequisite = switch (ScreenPath.fromLocation(
        state.uri.path,
      )) {
        Screen.result || Screen.nav => app.route == null,
        Screen.loading => app.routePhase == null,
        Screen.error => app.routeErrorKind == null,
        _ => false,
      };
      return missingPrerequisite ? Screen.home.path : null;
    },
    routes: [
      GoRoute(
        path: '/onboarding',
        pageBuilder: (context, state) => _page(
          state,
          const PopScope(canPop: false, child: OnboardingScreen()),
        ),
      ),
      GoRoute(
        path: '/home',
        pageBuilder: (context, state) =>
            _page(state, const PopScope(canPop: false, child: HomeScreen())),
        routes: [
          GoRoute(
            path: 'settings',
            pageBuilder: (context, state) =>
                _page(state, const SettingsScreen()),
            routes: [
              GoRoute(
                path: 'auth',
                pageBuilder: (context, state) =>
                    _page(state, const AuthScreen()),
              ),
            ],
          ),
          GoRoute(
            path: 'search',
            pageBuilder: (context, state) => _page(state, const SearchScreen()),
          ),
          GoRoute(
            path: 'search-origin',
            pageBuilder: (context, state) =>
                _page(state, const SearchScreen(mode: SearchMode.origin)),
          ),
          GoRoute(
            path: 'loading',
            pageBuilder: (context, state) => _page(
              state,
              const PopScope(canPop: false, child: LoadingScreen()),
            ),
          ),
          GoRoute(
            path: 'result',
            pageBuilder: (context, state) => _page(state, const ResultScreen()),
          ),
          GoRoute(
            path: 'nav',
            pageBuilder: (context, state) => _page(state, const NavScreen()),
          ),
          GoRoute(
            path: 'error',
            pageBuilder: (context, state) => _page(state, const ErrorScreen()),
          ),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
