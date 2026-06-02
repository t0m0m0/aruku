import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/constants/app_constants.dart';
import '../../core/services/onboarding_repository.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';
import '../../shared/widgets/logo.dart';

part 'onboarding_pages.dart';
part 'onboarding_widgets.dart';

/// 下部に固定するドット行とCTAの位置。各ページ本文の下部余白
/// [_pageBottomReserve] はこれらと重ならないよう確保するため、
/// いずれかを変更する場合は合わせて調整すること。
const double _dotsBottom = 188;
const double _ctaBottom = 64;
const double _pageBottomReserve = 220;

/// 起動ごとに一度だけ解決すればよいため、ページ再ビルードで
/// future を作り直さないようトップレベルでキャッシュする。
final Future<PackageInfo> _packageInfoFuture = PackageInfo.fromPlatform();

/// カードの落ち影に使う共通カラー。
const _cardShadow = BoxShadow(
  color: Color(0x1A22361E),
  blurRadius: 40,
  offset: Offset(0, 16),
);

class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  static const _pageCount = 3;
  final _controller = PageController();
  int _page = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onCta() {
    if (_page >= _pageCount - 1) {
      // 完了フラグの永続化はディスク待ちで遷移を遅らせないよう背景で行う。
      unawaited(_persistCompletion());
      ref.read(appStateProvider.notifier).go(Screen.home);
      return;
    }
    _controller.nextPage(
      duration: const Duration(milliseconds: 320),
      curve: Curves.easeOutCubic,
    );
  }

  Future<void> _persistCompletion() async {
    // fire-and-forget で呼ばれるため、書き込み失敗が unhandled async error に
    // ならないよう握り潰す。失敗時は次回起動で再びオンボーディングが出るだけ。
    try {
      final repo = await ref.read(onboardingRepositoryProvider.future);
      await repo.markCompleted();
    } catch (e) {
      debugPrint('onboarding completion persist error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final isLast = _page == _pageCount - 1;
    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Stack(
          children: [
            // Organic shapes
            Positioned(
              top: -60,
              right: -100,
              child: SizedBox(
                width: 460,
                height: 460,
                child: CustomPaint(
                  painter: _BlobPainter(
                    c.moss100.withValues(alpha: 0.55),
                    large: true,
                  ),
                ),
              ),
            ),
            Positioned(
              top: 100,
              left: -90,
              child: SizedBox(
                width: 320,
                height: 320,
                child: CustomPaint(
                  painter: _BlobPainter(
                    c.moss50.withValues(alpha: 0.6),
                    large: false,
                  ),
                ),
              ),
            ),

            // Logo header (全ページ共通で固定)
            Positioned(
              top: 12,
              left: 28,
              child: Row(
                children: [
                  const ArukuLogo(size: 36),
                  const SizedBox(width: 10),
                  Text(
                    'あるく',
                    style: jpStyle(
                      size: 22,
                      weight: FontWeight.w800,
                      color: c.moss700,
                      letterSpacing: 0.04 * 22,
                    ),
                  ),
                ],
              ),
            ),

            // Swipeable pages
            Positioned.fill(
              child: PageView(
                controller: _controller,
                onPageChanged: (i) => setState(() => _page = i),
                children: const [
                  _CorePage(key: Key('onboard-page-0')),
                  _HowToPage(key: Key('onboard-page-1')),
                  _RecordPage(key: Key('onboard-page-2')),
                ],
              ),
            ),

            // Pager dots (現在ページと連動)
            Positioned(
              left: 0,
              right: 0,
              bottom: _dotsBottom,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(_pageCount, (i) {
                  final active = i == _page;
                  return AnimatedContainer(
                    key: Key('onboard-dot-$i'),
                    duration: const Duration(milliseconds: 240),
                    curve: Curves.easeOut,
                    margin: const EdgeInsets.symmetric(horizontal: 3.5),
                    width: active ? 26 : 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: active ? c.moss500 : c.moss200,
                      borderRadius: BorderRadius.circular(999),
                    ),
                  );
                }),
              ),
            ),

            // CTA
            Positioned(
              left: 24,
              right: 24,
              bottom: _ctaBottom,
              child: Column(
                children: [
                  _CTAButton(label: isLast ? 'はじめる' : '次へ', onPressed: _onCta),
                  const SizedBox(height: 14),
                  Text(
                    '続行で利用規約とプライバシーに同意したことになります',
                    style: jpStyle(
                      size: 12,
                      weight: FontWeight.w500,
                      color: c.ink3,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// オンボーディング各ページの共通レイアウト。
/// ロゴヘッダーと下部のドット／CTA を避けるための余白を確保し、
/// 小さな画面でもあふれないようスクロール可能にする。
