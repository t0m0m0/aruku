import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  late final TextEditingController _ctl;
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _ctl = TextEditingController(text: '渋谷');
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _ctl.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final query = _ctl.text;
    final notifier = ref.read(appStateProvider.notifier);

    final suggestions = [
      _Suggestion('渋谷ヒカリエ', '東京都渋谷区渋谷2-21-1', '4.4km', '渋谷'),
      _Suggestion('渋谷スクランブル交差点', '東京都渋谷区道玄坂2', '4.6km', '渋谷'),
      _Suggestion('渋谷駅', 'JR・東京メトロ・東急', '4.5km', '渋谷'),
      _Suggestion('渋谷区役所', '東京都渋谷区宇田川町1', '4.8km', '渋谷'),
    ];
    final recents = [
      _Recent('表参道ヒルズ', '東京都渋谷区神宮前4', _RecentIcon.pin),
      _Recent('新宿御苑', '東京都新宿区内藤町11', _RecentIcon.leaf),
      _Recent('東京駅 丸の内中央口', '東京都千代田区丸の内1', _RecentIcon.train),
    ];

    return Material(
      color: c.ivory,
      child: SafeArea(
        child: Column(
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 14),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => notifier.go(Screen.home),
                    icon: Ic.chevron(
                      size: 20,
                      color: c.ink,
                      dir: ChevronDir.left,
                    ),
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      fixedSize: const Size(40, 40),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Container(
                      height: 44,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      decoration: BoxDecoration(
                        color: c.paper,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: c.hairline),
                      ),
                      child: Row(
                        children: [
                          Ic.search(size: 18, color: c.ink3),
                          const SizedBox(width: 10),
                          Expanded(
                            child: TextField(
                              controller: _ctl,
                              focusNode: _focus,
                              onChanged: (_) => setState(() {}),
                              cursorColor: c.moss500,
                              style: jpStyle(
                                size: 16,
                                weight: FontWeight.w600,
                                color: c.ink,
                              ),
                              decoration: const InputDecoration(
                                isCollapsed: true,
                                border: InputBorder.none,
                                contentPadding: EdgeInsets.symmetric(
                                  vertical: 12,
                                ),
                                hintText: '目的地を検索',
                              ),
                            ),
                          ),
                          if (_ctl.text.isNotEmpty)
                            InkWell(
                              onTap: () => setState(() => _ctl.clear()),
                              child: Ic.close(size: 18, color: c.ink3),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 8),
                children: [
                  if (query.isNotEmpty)
                    for (final s in suggestions)
                      _SuggestionTile(
                        sug: s,
                        onTap: () {
                          notifier.setDestination(s.name);
                          notifier.go(Screen.home);
                        },
                      ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(22, 18, 22, 6),
                    child: Row(
                      children: [
                        Ic.history(size: 12, color: c.ink3),
                        const SizedBox(width: 6),
                        Text(
                          '最近の検索',
                          style: jpStyle(
                            size: 10,
                            weight: FontWeight.w800,
                            color: c.ink3,
                            letterSpacing: 0.12 * 10,
                          ),
                        ),
                      ],
                    ),
                  ),
                  for (final r in recents)
                    _RecentTile(
                      recent: r,
                      onTap: () {
                        notifier.setDestination(r.name);
                        notifier.go(Screen.home);
                      },
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

class _Suggestion {
  _Suggestion(this.name, this.sub, this.dist, this.match);
  final String name;
  final String sub;
  final String dist;
  final String match;
}

enum _RecentIcon { pin, leaf, train }

class _Recent {
  _Recent(this.name, this.sub, this.icon);
  final String name;
  final String sub;
  final _RecentIcon icon;
}

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({required this.sug, required this.onTap});
  final _Suggestion sug;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rest = sug.name.replaceFirst(sug.match, '');
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: c.moss50,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Center(child: Ic.pin(size: 18, color: c.moss600)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  RichText(
                    overflow: TextOverflow.ellipsis,
                    text: TextSpan(
                      style: jpStyle(
                        size: 16,
                        weight: FontWeight.w700,
                        color: c.ink,
                      ),
                      children: [
                        TextSpan(
                          text: sug.match,
                          style: TextStyle(
                            color: c.moss700,
                            backgroundColor: c.moss100,
                          ),
                        ),
                        TextSpan(text: rest),
                      ],
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sug.sub,
                    style: jpStyle(
                      size: 12,
                      weight: FontWeight.w500,
                      color: c.ink3,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  sug.dist,
                  style: numStyle(
                    size: 13,
                    weight: FontWeight.w600,
                    color: c.moss600,
                  ),
                ),
                Text(
                  '歩なら',
                  style: jpStyle(
                    size: 10,
                    weight: FontWeight.w600,
                    color: c.ink3,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RecentTile extends StatelessWidget {
  const _RecentTile({required this.recent, required this.onTap});
  final _Recent recent;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    Widget icon;
    switch (recent.icon) {
      case _RecentIcon.leaf:
        icon = Ic.leaf(size: 16, color: c.ink3);
        break;
      case _RecentIcon.train:
        icon = Ic.train(size: 16, color: c.ink3);
        break;
      case _RecentIcon.pin:
        icon = Ic.pin(size: 16, color: c.ink3);
        break;
    }
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 10),
        child: Row(
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                border: Border.all(color: c.hairline),
                borderRadius: BorderRadius.circular(11),
              ),
              child: Center(child: icon),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    recent.name,
                    style: jpStyle(
                      size: 15,
                      weight: FontWeight.w700,
                      color: c.ink,
                    ),
                  ),
                  Text(
                    recent.sub,
                    style: jpStyle(
                      size: 11,
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
