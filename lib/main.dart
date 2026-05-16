import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/state/app_state.dart';
import 'core/theme/aruku_theme.dart';
import 'features/home/home_screen.dart';
import 'features/loading/loading_screen.dart';
import 'features/navigation/nav_screen.dart';
import 'features/onboarding/onboarding_screen.dart';
import 'features/picker/time_picker_sheet.dart';
import 'features/result/result_screen.dart';
import 'features/search/search_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
    ),
  );
  runApp(const ProviderScope(child: ArukuApp()));
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
    final pickerOpen = state.picker != null;

    final Widget body = switch (screen) {
      Screen.onboarding => const OnboardingScreen(),
      Screen.home => const HomeScreen(),
      Screen.search => const SearchScreen(),
      Screen.loading => const LoadingScreen(),
      Screen.result => const ResultScreen(),
      Screen.nav => const NavScreen(),
    };

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (pickerOpen) {
          ref.read(appStateProvider.notifier).closePicker();
          return;
        }
        if (screen == Screen.search ||
            screen == Screen.result ||
            screen == Screen.nav) {
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
          if (pickerOpen) ...[
            Positioned.fill(
              child: GestureDetector(
                onTap: () => ref.read(appStateProvider.notifier).closePicker(),
                child: Container(color: const Color(0x7314281C)),
              ),
            ),
            const Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: _PickerSlideIn(),
            ),
          ],
        ],
      ),
    );
  }
}

class _PickerSlideIn extends StatefulWidget {
  const _PickerSlideIn();

  @override
  State<_PickerSlideIn> createState() => _PickerSlideInState();
}

class _PickerSlideInState extends State<_PickerSlideIn>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctl;

  @override
  void initState() {
    super.initState();
    _ctl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 280),
    )..forward();
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final anim = CurvedAnimation(
      parent: _ctl,
      curve: const Cubic(0.2, 0.8, 0.2, 1.0),
    );
    return SlideTransition(
      position: Tween<Offset>(
        begin: const Offset(0, 1),
        end: Offset.zero,
      ).animate(anim),
      child: const TimePickerSheet(),
    );
  }
}
