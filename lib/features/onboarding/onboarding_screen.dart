import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/logo.dart';

class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.c;
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

            // Content
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 28),
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
                  const SizedBox(height: 64),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 32),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'WALK FIRST · v1.0',
                          style: jpStyle(
                            size: 11,
                            weight: FontWeight.w700,
                            color: c.moss600,
                            letterSpacing: 0.2 * 11,
                          ),
                        ),
                        const SizedBox(height: 18),
                        RichText(
                          text: TextSpan(
                            style: jpStyle(
                              size: 40,
                              weight: FontWeight.w800,
                              color: c.ink,
                              height: 1.18,
                              letterSpacing: -0.01 * 40,
                            ),
                            children: [
                              const TextSpan(text: '電車はなるべく、\n'),
                              TextSpan(
                                text: '乗らない',
                                style: TextStyle(color: c.moss600),
                              ),
                              const TextSpan(text: '。'),
                            ],
                          ),
                        ),
                        const SizedBox(height: 18),
                        SizedBox(
                          width: 290,
                          child: Text(
                            '時間内に着く範囲で、\nいちばん歩けるルートを案内します。',
                            style: jpStyle(
                              size: 16,
                              weight: FontWeight.w500,
                              color: c.ink2,
                              height: 1.7,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Spacer(),
                ],
              ),
            ),

            // Stats teaser
            Positioned(left: 28, right: 28, top: 410, child: _StatsTeaser()),

            // Pager dots
            Positioned(
              left: 0,
              right: 0,
              bottom: 188,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(3, (i) {
                  return Container(
                    margin: const EdgeInsets.symmetric(horizontal: 3.5),
                    width: i == 0 ? 26 : 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: i == 0 ? c.moss500 : c.moss200,
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
              bottom: 64,
              child: Column(
                children: [
                  _CTAButton(
                    label: 'はじめる',
                    onPressed: () =>
                        ref.read(appStateProvider.notifier).go(Screen.home),
                  ),
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

class _StatsTeaser extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
      decoration: BoxDecoration(
        color: c.paper,
        borderRadius: BorderRadius.circular(22),
        boxShadow: const [
          BoxShadow(
            color: Color(0x1A22361E),
            blurRadius: 40,
            offset: Offset(0, 16),
          ),
        ],
        border: Border.all(color: c.hairline),
      ),
      child: Row(
        children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: c.burntSoft,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Center(child: Ic.fire(size: 28, color: c.burnt)),
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
                      '1,840',
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
    return Material(
      color: c.moss500,
      borderRadius: BorderRadius.circular(18),
      elevation: 0,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(18),
        child: Ink(
          height: 56,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            boxShadow: const [
              BoxShadow(
                color: Color(0x52496A24),
                blurRadius: 24,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: Center(
            child: Text(
              label,
              style: jpStyle(
                size: 17,
                weight: FontWeight.w700,
                color: c.ivory,
                letterSpacing: 0.04 * 17,
              ),
            ),
          ),
        ),
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
