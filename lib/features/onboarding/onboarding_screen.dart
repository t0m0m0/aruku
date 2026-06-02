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
class _OnboardPage extends StatelessWidget {
  const _OnboardPage({
    required this.eyebrow,
    required this.title,
    required this.description,
    this.visual,
  });

  final Widget eyebrow;
  final List<TextSpan> title;
  final String description;
  final Widget? visual;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(32, 84, 32, _pageBottomReserve),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          eyebrow,
          const SizedBox(height: 18),
          RichText(
            text: TextSpan(
              style: jpStyle(
                size: 38,
                weight: FontWeight.w800,
                color: c.ink,
                height: 1.18,
                letterSpacing: -0.01 * 38,
              ),
              children: title,
            ),
          ),
          const SizedBox(height: 18),
          Text(
            description,
            style: jpStyle(
              size: 16,
              weight: FontWeight.w500,
              color: c.ink2,
              height: 1.7,
            ),
          ),
          if (visual != null) ...[const SizedBox(height: 28), visual!],
        ],
      ),
    );
  }
}

class _CorePage extends StatelessWidget {
  const _CorePage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _OnboardPage(
      eyebrow: FutureBuilder<PackageInfo>(
        future: _packageInfoFuture,
        builder: (context, snap) {
          final version = snap.hasData ? snap.data!.version : '...';
          return Text(
            'WALK FIRST · v$version',
            style: jpStyle(
              size: 11,
              weight: FontWeight.w700,
              color: c.moss600,
              letterSpacing: 0.2 * 11,
            ),
          );
        },
      ),
      title: [
        const TextSpan(text: '電車はなるべく、\n'),
        TextSpan(
          text: '乗らない',
          style: TextStyle(color: c.moss600),
        ),
        const TextSpan(text: '。'),
      ],
      description: '時間内に着く範囲で、\nいちばん歩けるルートを案内します。',
      visual: _StatsTeaser(),
    );
  }
}

class _HowToPage extends StatelessWidget {
  const _HowToPage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _OnboardPage(
      eyebrow: _Eyebrow('HOW IT WORKS', color: c.moss600),
      title: [
        const TextSpan(text: '着く時間を、\n'),
        TextSpan(
          text: '指定するだけ',
          style: TextStyle(color: c.moss600),
        ),
        const TextSpan(text: '。'),
      ],
      description: 'あとはアプリが、間に合う範囲で\nいちばん歩けるルートを選びます。',
      visual: _FeatureCard(
        icon: Ic.clock(size: 28, color: c.moss600),
        iconBg: c.moss50,
        title: '到着時刻をセット',
        subtitle: '出発／到着のどちらでも指定できます',
      ),
    );
  }
}

class _RecordPage extends StatelessWidget {
  const _RecordPage({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _OnboardPage(
      eyebrow: _Eyebrow('YOUR RECORD', color: c.moss600),
      title: [
        const TextSpan(text: 'あなたの歩みを、\n'),
        TextSpan(
          text: '記録する',
          style: TextStyle(color: c.moss600),
        ),
        const TextSpan(text: '。'),
      ],
      description: '歩数・距離・消費カロリーを記録して、\n続けた歩みを可視化します。',
      visual: _FeatureCard(
        icon: Ic.walk(size: 28, color: c.burnt),
        iconBg: c.burntSoft,
        title: '毎日の歩みを記録',
        subtitle: '歩数・距離・カロリーをまとめて確認',
      ),
    );
  }
}

class _Eyebrow extends StatelessWidget {
  const _Eyebrow(this.text, {required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: jpStyle(
        size: 11,
        weight: FontWeight.w700,
        color: color,
        letterSpacing: 0.2 * 11,
      ),
    );
  }
}

/// カードの共通外殻（余白・角丸・落ち影・枠線）。
class _Card extends StatelessWidget {
  const _Card({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ArukuCard(
      borderRadius: 22,
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
      shadow: const [_cardShadow],
      child: child,
    );
  }
}

/// カード左側の角丸アイコン枠（56x56）。
class _CardIcon extends StatelessWidget {
  const _CardIcon({required this.icon, required this.bg});
  final Widget icon;
  final Color bg;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Center(child: icon),
    );
  }
}

class _FeatureCard extends StatelessWidget {
  const _FeatureCard({
    required this.icon,
    required this.iconBg,
    required this.title,
    required this.subtitle,
  });

  final Widget icon;
  final Color iconBg;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _Card(
      child: Row(
        children: [
          _CardIcon(icon: icon, bg: iconBg),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: jpStyle(
                    size: 15,
                    weight: FontWeight.w700,
                    color: c.ink,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
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
    );
  }
}

class _StatsTeaser extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return _Card(
      child: Row(
        children: [
          _CardIcon(
            icon: Ic.fire(size: 28, color: c.burnt),
            bg: c.burntSoft,
          ),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '最初の1週間で',
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w600,
                    color: c.ink3,
                    letterSpacing: 0.06 * 11,
                  ),
                ),
                const SizedBox(height: 2),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      '${AppConstants.weeklyKcalEstimate ~/ 1000},${(AppConstants.weeklyKcalEstimate % 1000).toString().padLeft(3, '0')}',
                      style: numStyle(
                        size: 32,
                        weight: FontWeight.w600,
                        color: c.ink,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'kcal',
                      style: jpStyle(
                        size: 13,
                        weight: FontWeight.w700,
                        color: c.ink2,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        '通勤を歩くだけで',
                        style: jpStyle(
                          size: 12,
                          weight: FontWeight.w500,
                          color: c.ink3,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CTAButton extends StatelessWidget {
  const _CTAButton({required this.label, required this.onPressed});
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuButton(
      label: label,
      onPressed: onPressed,
      backgroundColor: c.moss500,
      height: 56,
      borderRadius: 18,
      shadow: const [
        BoxShadow(
          color: Color(0x52496A24),
          blurRadius: 24,
          offset: Offset(0, 8),
        ),
      ],
      textStyle: jpStyle(
        size: 17,
        weight: FontWeight.w700,
        color: c.ivory,
        letterSpacing: 0.04 * 17,
      ),
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter(this.color, {required this.large});
  final Color color;
  final bool large;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = color;
    final path = Path();
    if (large) {
      path.moveTo(size.width * 0.5, size.height * 0.075);
      path.cubicTo(
        size.width * 0.875,
        size.height * 0.15,
        size.width * 0.9,
        size.height * 0.5,
        size.width * 0.5,
        size.height * 0.9,
      );
      path.cubicTo(
        size.width * 0.15,
        size.height * 0.85,
        size.width * 0.125,
        size.height * 0.5,
        size.width * 0.5,
        size.height * 0.075,
      );
    } else {
      path.moveTo(size.width * 0.25, size.height * 0.05);
      path.cubicTo(
        size.width * 0.7,
        size.height * 0.1,
        size.width * 0.8,
        size.height * 0.45,
        size.width * 0.35,
        size.height * 0.85,
      );
      path.cubicTo(
        size.width * 0.075,
        size.height * 0.75,
        size.width * 0.075,
        size.height * 0.45,
        size.width * 0.25,
        size.height * 0.05,
      );
    }
    path.close();
    canvas.drawPath(path, p);
  }

  @override
  bool shouldRepaint(_BlobPainter old) => old.color != color;
}
