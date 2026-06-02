part of 'onboarding_screen.dart';

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
