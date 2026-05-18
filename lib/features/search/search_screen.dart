import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/geo_point.dart';
import '../../core/models/location_state.dart';
import '../../core/models/place_prediction.dart';
import '../../core/services/places_service.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_colors.dart';
import '../../core/theme/aruku_theme.dart';
import '../../shared/icons/ic.dart';
import 'places_provider.dart';

enum SearchMode { destination, origin }

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key, this.mode = SearchMode.destination});

  final SearchMode mode;

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  late final TextEditingController _ctl;
  final _focus = FocusNode();
  bool _selecting = false;

  @override
  void initState() {
    super.initState();
    _ctl = TextEditingController();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _ctl.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _selectPrediction(String placeId, String name) async {
    if (_selecting) return;
    setState(() => _selecting = true);
    try {
      final service = ref.read(placesServiceProvider);
      final latLng = await service.fetchLatLng(placeId);
      if (!mounted) return;
      _applySelection(name, latLng: latLng);
    } on PlacesException {
      if (!mounted) return;
      _applySelection(name);
    } finally {
      if (mounted) setState(() => _selecting = false);
    }
  }

  void _applySelection(String name, {GeoPoint? latLng}) {
    final notifier = ref.read(appStateProvider.notifier);
    if (widget.mode == SearchMode.origin) {
      notifier.setOrigin(name, latLng: latLng);
    } else {
      notifier.setDestination(name, latLng: latLng);
    }
    notifier.go(Screen.home);
  }

  void _useCurrentLocation() {
    final notifier = ref.read(appStateProvider.notifier);
    if (widget.mode == SearchMode.origin) {
      notifier.setOrigin(null);
      notifier.go(Screen.home);
      return;
    }
    final locationState = ref.read(appStateProvider).locationState;
    if (locationState case LocationAvailable(:final position)) {
      notifier.setDestination('現在地', latLng: position);
      notifier.go(Screen.home);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final notifier = ref.read(appStateProvider.notifier);
    final searchState = ref.watch(placesProvider);

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
                              onChanged: (q) {
                                setState(() {});
                                ref.read(placesProvider.notifier).search(q);
                              },
                              cursorColor: c.moss500,
                              style: jpStyle(
                                size: 16,
                                weight: FontWeight.w600,
                                color: c.ink,
                              ),
                              decoration: InputDecoration(
                                isCollapsed: true,
                                border: InputBorder.none,
                                contentPadding: const EdgeInsets.symmetric(
                                  vertical: 12,
                                ),
                                hintText: widget.mode == SearchMode.origin
                                    ? '出発地を検索'
                                    : '目的地を検索',
                              ),
                            ),
                          ),
                          if (_ctl.text.isNotEmpty)
                            InkWell(
                              onTap: () {
                                setState(() => _ctl.clear());
                                ref.read(placesProvider.notifier).search('');
                              },
                              child: Ic.close(size: 18, color: c.ink3),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Expanded(child: _buildBody(c, searchState, notifier)),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(
    ArukuColors c,
    SearchState searchState,
    AppNotifier notifier,
  ) {
    // 入力中: ローディングまたは候補リスト
    if (_ctl.text.isNotEmpty) {
      return switch (searchState.status) {
        SearchStatus.idle => const SizedBox.shrink(),
        SearchStatus.loading => _buildLoading(c),
        SearchStatus.error => _buildError(c, searchState.errorMessage),
        SearchStatus.success =>
          searchState.suggestions.isEmpty
              ? _buildEmpty(c)
              : _buildSuggestions(c, searchState.suggestions),
      };
    }

    // 空欄: 最近の検索（固定）
    return _buildRecents(c, notifier);
  }

  Widget _buildLoading(ArukuColors c) {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: List.generate(
        4,
        (_) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 10),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: c.hairline,
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      height: 14,
                      width: double.infinity,
                      decoration: BoxDecoration(
                        color: c.hairline,
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Container(
                      height: 10,
                      width: 160,
                      decoration: BoxDecoration(
                        color: c.hairline,
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildError(ArukuColors c, String? message) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Ic.search(size: 32, color: c.ink3),
          const SizedBox(height: 12),
          Text(
            message ?? '検索できませんでした',
            style: jpStyle(size: 14, weight: FontWeight.w600, color: c.ink3),
          ),
          const SizedBox(height: 6),
          Text(
            '通信状況を確認してください',
            style: jpStyle(size: 12, weight: FontWeight.w500, color: c.ink3),
          ),
        ],
      ),
    );
  }

  Widget _buildEmpty(ArukuColors c) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Ic.pin(size: 32, color: c.ink3),
          const SizedBox(height: 12),
          Text(
            '候補が見つかりませんでした',
            style: jpStyle(size: 14, weight: FontWeight.w600, color: c.ink3),
          ),
          const SizedBox(height: 6),
          Text(
            '別のキーワードで試してください',
            style: jpStyle(size: 12, weight: FontWeight.w500, color: c.ink3),
          ),
        ],
      ),
    );
  }

  Widget _buildSuggestions(ArukuColors c, List<PlacePrediction> suggestions) {
    return Stack(
      children: [
        IgnorePointer(
          ignoring: _selecting,
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 8),
            itemCount: suggestions.length,
            itemBuilder: (_, i) {
              final s = suggestions[i];
              return _SuggestionTile(
                name: s.name,
                address: s.address,
                query: _ctl.text,
                onTap: () => _selectPrediction(s.placeId, s.name),
              );
            },
          ),
        ),
        if (_selecting)
          Center(child: CircularProgressIndicator(color: c.moss500)),
      ],
    );
  }

  Widget _buildRecents(ArukuColors c, AppNotifier notifier) {
    if (widget.mode == SearchMode.destination) {
      final locationState = ref.watch(
        appStateProvider.select((s) => s.locationState),
      );
      if (locationState is! LocationAvailable) return const SizedBox.shrink();
    }
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        InkWell(
          onTap: _useCurrentLocation,
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
                  child: Center(child: Ic.compass(size: 18, color: c.moss600)),
                ),
                const SizedBox(width: 14),
                Text(
                  '現在地を使う',
                  style: jpStyle(
                    size: 16,
                    weight: FontWeight.w600,
                    color: c.ink,
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({
    required this.name,
    required this.address,
    required this.query,
    required this.onTap,
  });

  final String name;
  final String address;
  final String query;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final lowerName = name.toLowerCase();
    final lowerQuery = query.toLowerCase();
    final matchStart = lowerName.indexOf(lowerQuery);

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
                  matchStart >= 0
                      ? RichText(
                          overflow: TextOverflow.ellipsis,
                          text: TextSpan(
                            style: jpStyle(
                              size: 16,
                              weight: FontWeight.w700,
                              color: c.ink,
                            ),
                            children: [
                              if (matchStart > 0)
                                TextSpan(text: name.substring(0, matchStart)),
                              TextSpan(
                                text: name.substring(
                                  matchStart,
                                  matchStart + query.length,
                                ),
                                style: TextStyle(
                                  color: c.moss700,
                                  backgroundColor: c.moss100,
                                ),
                              ),
                              TextSpan(
                                text: name.substring(matchStart + query.length),
                              ),
                            ],
                          ),
                        )
                      : Text(
                          name,
                          overflow: TextOverflow.ellipsis,
                          style: jpStyle(
                            size: 16,
                            weight: FontWeight.w700,
                            color: c.ink,
                          ),
                        ),
                  const SizedBox(height: 2),
                  Text(
                    address,
                    overflow: TextOverflow.ellipsis,
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
