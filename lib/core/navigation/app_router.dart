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
///
/// テストが遷移完了を待つ際にも参照できるよう公開する（マジックナンバーの
/// 散在を避け、値を変えてもテストが自動追従する）。
const kRouteTransitionDuration = Duration(milliseconds: 220);

CustomTransitionPage<void> _page(GoRouterState state, Widget child) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    transitionDuration: kRouteTransitionDuration,
    reverseTransitionDuration: kRouteTransitionDuration,
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
/// [AppState.screen] はそのミラー。
///
/// 同期は双方向:
/// - state → router: [AppNotifier.go] 等による screen 変更を `ref.listen`
///   で拾い `router.go` する（notifier は router を参照しない。これにより
///   widget ツリーなしの state テストが router 非依存で成立する）。
/// - router → state: pop / deep link / redirect による遷移を
///   `routerDelegate` のリスナで拾い [AppNotifier.syncScreen] へ書き戻す。
///
/// エコーは三重に遮断される: syncScreen の同値 early-return、下記 listen 側の
/// path 比較、go_router 自身の同一 location no-op。
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
      return missingPrerequisite ? ScreenPath.fallback.path : null;
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
  // state → router: screen の変更を location へ伝搬する。
  ref.listen(appStateProvider.select((s) => s.screen), (_, next) {
    final config = router.routerDelegate.currentConfiguration;
    // Router 未 attach（config 空）の間も go は安全（最新値が attach 時に効く）。
    if (config.isNotEmpty && config.uri.path == next.path) return;
    router.go(next.path);
  });

  // router → state: pop / deep link / redirect の結果を書き戻す。
  // router.state は attach 前に throw するため currentConfiguration を読む。
  void syncFromRouter() {
    final config = router.routerDelegate.currentConfiguration;
    if (config.isEmpty) return;
    ref
        .read(appStateProvider.notifier)
        .syncScreen(ScreenPath.fromLocation(config.uri.path));
  }

  router.routerDelegate.addListener(syncFromRouter);
  ref.onDispose(() {
    router.routerDelegate.removeListener(syncFromRouter);
    router.dispose();
  });
  return router;
});
