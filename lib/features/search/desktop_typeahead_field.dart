import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/place_prediction.dart';
import '../../core/models/recent_place.dart';
import '../../core/services/places_service.dart';
import '../../core/state/app_state.dart';
import '../../core/state/recents_provider.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/icons/ic.dart';
import 'place_selection.dart';
import 'places_provider.dart';
import 'search_screen.dart' show SearchMode;

/// デスクトップ幅の地点入力。全画面遷移をやめ、その場のドロップダウンで確定する。
///
/// 全画面検索を widget ごと流用しないのは、あちらが「開いて、選び、戻る」という
/// 遷移そのものを前提に組まれているため（確定時に home へ go する）。ここは
/// 画面に留まったまま確定する。確定処理だけは [resolvePlacePrediction] で共有する。
class DesktopTypeaheadField extends ConsumerStatefulWidget {
  const DesktopTypeaheadField({
    super.key,
    required this.mode,
    required this.hintText,
  });

  final SearchMode mode;
  final String hintText;

  @override
  ConsumerState<DesktopTypeaheadField> createState() =>
      _DesktopTypeaheadFieldState();
}

class _DesktopTypeaheadFieldState extends ConsumerState<DesktopTypeaheadField> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();
  final _link = LayerLink();
  final _portal = OverlayPortalController();

  int _highlighted = 0;
  bool _selecting = false;
  bool _pickFailed = false;

  String get _side =>
      widget.mode == SearchMode.origin ? 'origin' : 'destination';

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  List<PlacePrediction> get _options => ref.read(placesProvider).suggestions;

  void _open() {
    if (_portal.isShowing) return;
    _portal.show();
  }

  void _close() {
    if (!_portal.isShowing) return;
    _portal.hide();
    setState(() => _highlighted = 0);
  }

  void _onChanged(String query) {
    ref.read(placesProvider.notifier).search(query);
    setState(() {
      _highlighted = 0;
      _pickFailed = false;
    });
    if (query.isEmpty) {
      _close();
      return;
    }
    _open();
  }

  void _move(int delta) {
    final options = _options;
    if (options.isEmpty) return;
    setState(
      () => _highlighted = (_highlighted + delta).clamp(0, options.length - 1),
    );
  }

  Future<void> _confirmHighlighted() async {
    final options = _options;
    if (options.isEmpty || _highlighted >= options.length) return;
    await _select(options[_highlighted]);
  }

  Future<void> _select(PlacePrediction prediction) async {
    if (_selecting) return;
    setState(() => _selecting = true);
    final resolved = await resolvePlacePrediction(
      ref.read(placesServiceProvider),
      prediction,
    );
    if (!mounted) return;
    // 座標を引けない候補は確定させない。黙って無反応にすると「押しても何も
    // 起きない候補」になるため、理由をドロップダウンへ出して選び直させる。
    setState(() {
      _selecting = false;
      _pickFailed = resolved == null;
    });
    if (resolved == null) return;
    _apply(resolved);
  }

  void _apply(RecentPlace place) {
    final notifier = ref.read(appStateProvider.notifier);
    if (widget.mode == SearchMode.origin) {
      unawaited(ref.read(recentOriginsProvider.notifier).add(place));
      notifier.setOrigin(place.name, latLng: place.latLng);
    } else {
      unawaited(ref.read(recentsProvider.notifier).add(place));
      notifier.setDestination(place.name, latLng: place.latLng);
    }
    _controller.clear();
    ref.read(placesProvider.notifier).search('');
    _close();
    _focusNode.unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final selected = widget.mode == SearchMode.origin
        ? ref.watch(appStateProvider.select((s) => s.origin))
        : ref.watch(appStateProvider.select((s) => s.destination));

    return TapRegion(
      groupId: _portal,
      onTapOutside: (_) => _close(),
      child: CompositedTransformTarget(
        link: _link,
        child: OverlayPortal(
          controller: _portal,
          overlayChildBuilder: _buildDropdown,
          child: Shortcuts(
            // WidgetsApp が根に置く DefaultTextEditingShortcuts より焦点に近い
            // ため、単一行の「行頭／行末へ移動」より先に効く。
            shortcuts: const {
              SingleActivator(LogicalKeyboardKey.arrowDown): _MoveIntent(1),
              SingleActivator(LogicalKeyboardKey.arrowUp): _MoveIntent(-1),
              SingleActivator(LogicalKeyboardKey.escape): _DismissIntent(),
              // Enter は onSubmitted だけに頼れない。生のキーイベントは
              // テキスト入力接続を通らず、確定アクションとして届かない。
              SingleActivator(LogicalKeyboardKey.enter): _ConfirmIntent(),
              SingleActivator(LogicalKeyboardKey.numpadEnter): _ConfirmIntent(),
            },
            child: Actions(
              actions: {
                _MoveIntent: CallbackAction<_MoveIntent>(
                  onInvoke: (intent) {
                    _move(intent.delta);
                    return null;
                  },
                ),
                _DismissIntent: CallbackAction<_DismissIntent>(
                  onInvoke: (_) {
                    _close();
                    return null;
                  },
                ),
                _ConfirmIntent: CallbackAction<_ConfirmIntent>(
                  onInvoke: (_) {
                    unawaited(_confirmHighlighted());
                    return null;
                  },
                ),
              },
              child: Container(
                height: 52,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                  color: c.ivory,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: _portal.isShowing ? c.moss400 : c.hairline,
                  ),
                ),
                child: Row(
                  children: [
                    Ic.search(size: 17, color: c.ink3),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        key: Key('desktop-typeahead-input-$_side'),
                        controller: _controller,
                        focusNode: _focusNode,
                        onChanged: _onChanged,
                        onSubmitted: (_) => unawaited(_confirmHighlighted()),
                        cursorColor: c.moss500,
                        style: jpStyle(
                          size: 15.5,
                          weight: FontWeight.w700,
                          color: c.ink,
                        ),
                        decoration: InputDecoration(
                          border: InputBorder.none,
                          isCollapsed: true,
                          hintText: selected ?? widget.hintText,
                          hintStyle: jpStyle(
                            size: 15.5,
                            weight: selected != null
                                ? FontWeight.w700
                                : FontWeight.w600,
                            color: selected != null ? c.ink : c.ink3,
                          ),
                        ),
                      ),
                    ),
                    if (selected != null)
                      IconButton(
                        key: Key('desktop-typeahead-clear-$_side'),
                        tooltip: l10n.searchClearInput,
                        onPressed: () {
                          final notifier = ref.read(appStateProvider.notifier);
                          if (widget.mode == SearchMode.origin) {
                            notifier.setOrigin(null);
                          } else {
                            notifier.setDestination(null);
                          }
                        },
                        icon: Ic.close(size: 16, color: c.ink3),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildDropdown(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final searchState = ref.watch(placesProvider);
    final options = searchState.suggestions;

    return CompositedTransformFollower(
      link: _link,
      targetAnchor: Alignment.bottomLeft,
      followerAnchor: Alignment.topLeft,
      offset: const Offset(0, 8),
      child: Align(
        alignment: Alignment.topLeft,
        child: TapRegion(
          groupId: _portal,
          // 幅はフィールドに揃える。leaderSize は対象のレイアウト後に決まる。
          child: SizedBox(
            width: _link.leaderSize?.width ?? 0,
            child: Material(
              key: Key('desktop-typeahead-dropdown-$_side'),
              color: c.paper,
              borderRadius: BorderRadius.circular(18),
              elevation: 8,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 460),
                child: _pickFailed
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(16, 22, 16, 22),
                        child: Text(
                          widget.mode == SearchMode.origin
                              ? l10n.searchPickFailedOrigin
                              : l10n.searchPickFailedDestination,
                          style: jpStyle(
                            size: 13.5,
                            weight: FontWeight.w600,
                            color: c.ink2,
                          ),
                        ),
                      )
                    : options.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(16, 22, 16, 22),
                        child: searchState.status == SearchStatus.loading
                            ? const Center(
                                child: SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              )
                            : Text(
                                l10n.searchEmptyTitle,
                                style: jpStyle(
                                  size: 14,
                                  weight: FontWeight.w600,
                                  color: c.ink2,
                                ),
                              ),
                      )
                    : SingleChildScrollView(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (var i = 0; i < options.length; i++)
                              _OptionRow(
                                option: options[i],
                                highlighted: i == _highlighted,
                                onTap: () => unawaited(_select(options[i])),
                                onHover: () => setState(() => _highlighted = i),
                              ),
                          ],
                        ),
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MoveIntent extends Intent {
  const _MoveIntent(this.delta);
  final int delta;
}

class _DismissIntent extends Intent {
  const _DismissIntent();
}

class _ConfirmIntent extends Intent {
  const _ConfirmIntent();
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.option,
    required this.highlighted,
    required this.onTap,
    required this.onHover,
  });

  final PlacePrediction option;
  final bool highlighted;
  final VoidCallback onTap;
  final VoidCallback onHover;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      onHover: (hovering) {
        if (hovering) onHover();
      },
      child: Container(
        color: highlighted ? c.moss50 : null,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Ic.pin(size: 16, color: c.moss600),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.name,
                    style: jpStyle(
                      size: 15,
                      weight: FontWeight.w700,
                      color: c.ink,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    option.address,
                    style: jpStyle(
                      size: 12.5,
                      weight: FontWeight.w500,
                      color: c.ink2,
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
