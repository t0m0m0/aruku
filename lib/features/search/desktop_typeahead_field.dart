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

/// インライン目的地入力の焦点。CTA など離れた場所から開くために共有する。
///
/// GlobalKey ではなくプロバイダにするのは、入力欄が条件カードの奥にあり、
/// 経路上のウィジェットを Stateful に変えていかないと参照を降ろせないため。
final desktopDestinationFocusProvider = Provider<FocusNode>((ref) {
  final node = FocusNode();
  ref.onDispose(node.dispose);
  return node;
});

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
  final _link = LayerLink();
  final _portal = OverlayPortalController();

  /// 目的地側だけ共有ノードを使う。CTA から開けるようにするため。
  late final FocusNode _focusNode = widget.mode == SearchMode.destination
      ? ref.read(desktopDestinationFocusProvider)
      : FocusNode();

  int _highlighted = 0;
  bool _selecting = false;
  bool _pickFailed = false;

  /// 座標の引き当てごとに増やす世代。fetchLatLng を待つ間も欄は編集できるため、
  /// 遅れて返った古い確定が、打ち替えた後のクエリを消して別の地点を入れてしまう。
  int _selectGeneration = 0;

  String get _side =>
      widget.mode == SearchMode.origin ? 'origin' : 'destination';

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _focusNode.removeListener(_onFocusChanged);
    // 共有ノードの寿命はプロバイダが持つ。ここで捨てると、次に開いたときに
    // 破棄済みのノードへ焦点を要求することになる。
    if (widget.mode != SearchMode.destination) _focusNode.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _onFocusChanged() {
    if (!_focusNode.hasFocus) return;
    // インラインの入力面には「近くの店」トグルが無い。全画面検索で入れた
    // モードを引き継ぐと、以後の候補が理由の見えないまま距離順で並び続ける。
    ref.read(placesProvider.notifier).setNearby(false);
    _open();
  }

  List<RecentPlace> get _recents =>
      (widget.mode == SearchMode.origin
              ? ref.read(recentOriginsProvider)
              : ref.read(recentsProvider))
          .value ??
      const [];

  /// ドロップダウンに並ぶ行。未入力なら履歴、入力中なら候補。
  /// キー操作と描画が同じ並びを見るよう、組み立てを1箇所に置く。
  List<_Entry> _entries() {
    if (_controller.text.isEmpty) {
      return [
        for (final r in _recents)
          _Entry(
            name: r.name,
            detail: r.address ?? '',
            onSelect: () => _apply(r),
          ),
      ];
    }
    return [
      for (final p in ref.read(placesProvider).suggestions)
        _Entry(
          name: p.name,
          detail: p.address,
          onSelect: () => unawaited(_select(p)),
        ),
    ];
  }

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
    // 打ち替えを始めた時点で、確定済みの地点は「今その欄が指しているもの」で
    // なくなる。残すと表示は新しいクエリ・状態は古い座標というズレが作れ、
    // 検索 CTA が有効なまま前の目的地へ経路を引いてしまう。
    _clearSelection();
    _selectGeneration++;
    ref.read(placesProvider.notifier).search(query);
    setState(() {
      _highlighted = 0;
      _pickFailed = false;
    });
    _open();
  }

  void _clearSelection() {
    final state = ref.read(appStateProvider);
    final notifier = ref.read(appStateProvider.notifier);
    if (widget.mode == SearchMode.origin) {
      if (state.origin != null) notifier.setOrigin(null);
    } else {
      if (state.destination != null) notifier.setDestination(null);
    }
  }

  void _move(int delta) {
    final entries = _entries();
    if (entries.isEmpty) return;
    setState(
      () => _highlighted = (_highlighted + delta).clamp(0, entries.length - 1),
    );
  }

  void _confirmHighlighted() {
    final entries = _entries();
    if (_highlighted >= entries.length) return;
    entries[_highlighted].onSelect();
  }

  Future<void> _select(PlacePrediction prediction) async {
    if (_selecting) return;
    final generation = ++_selectGeneration;
    setState(() => _selecting = true);
    final resolved = await resolvePlacePrediction(
      ref.read(placesServiceProvider),
      prediction,
    );
    if (!mounted) return;
    // 待っている間に打ち替えられていたら、この確定はもう欄が指していない。
    if (generation != _selectGeneration) {
      setState(() => _selecting = false);
      return;
    }
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
                    _confirmHighlighted();
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
                        onSubmitted: (_) => _confirmHighlighted(),
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
    final searchState = ref.watch(placesProvider);
    // 履歴の到着でも並びを組み直す（未入力時の行は履歴そのもの）。
    ref.watch(
      widget.mode == SearchMode.origin
          ? recentOriginsProvider
          : recentsProvider,
    );
    final entries = _entries();

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
                child: _dropdownBody(context, searchState, entries),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _dropdownBody(
    BuildContext context,
    SearchState searchState,
    List<_Entry> entries,
  ) {
    final l10n = AppLocalizations.of(context);

    if (_pickFailed) {
      return _message(
        context,
        widget.mode == SearchMode.origin
            ? l10n.searchPickFailedOrigin
            : l10n.searchPickFailedDestination,
      );
    }
    if (entries.isNotEmpty) {
      return SingleChildScrollView(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_controller.text.isEmpty)
              _Eyebrow(
                label: widget.mode == SearchMode.origin
                    ? l10n.searchRecentOrigins
                    : l10n.searchRecentDestinations,
              ),
            for (var i = 0; i < entries.length; i++)
              _OptionRow(
                entry: entries[i],
                highlighted: i == _highlighted,
                onHover: () => setState(() => _highlighted = i),
              ),
          ],
        ),
      );
    }
    // 未入力で履歴も無いときは、まだ何も起きていない。空振りの文言を出さない。
    if (_controller.text.isEmpty) return const SizedBox.shrink();
    if (searchState.status == SearchStatus.loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 22),
        child: Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    // 取得の失敗を「候補なし」と出すと、通信断・認証拒否・API 拒否が
    // すべて「そんな場所は無い」に見える。全画面検索と同じ文言を出す。
    if (searchState.status == SearchStatus.error) {
      final status = searchState.errorStatus;
      return _message(
        context,
        status == null
            ? l10n.searchErrorGeneric
            : l10n.searchErrorWithStatus(status),
        hint: l10n.searchNetworkHint,
      );
    }
    return _message(context, l10n.searchEmptyTitle, hint: l10n.searchEmptyHint);
  }

  Widget _message(BuildContext context, String text, {String? hint}) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 22, 16, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            text,
            style: jpStyle(size: 14, weight: FontWeight.w600, color: c.ink2),
          ),
          if (hint != null) ...[
            const SizedBox(height: 4),
            Text(
              hint,
              style: jpStyle(
                size: 12.5,
                weight: FontWeight.w500,
                color: c.ink3,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Eyebrow extends StatelessWidget {
  const _Eyebrow({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          label,
          style: jpStyle(
            size: 12,
            weight: FontWeight.w800,
            color: c.ink3,
            letterSpacing: 0.14 * 12,
          ),
        ),
      ),
    );
  }
}

/// ドロップダウンの1行。履歴と候補を同じ形に均し、キー操作と描画が
/// 同じ並びを見るようにする。
class _Entry {
  const _Entry({
    required this.name,
    required this.detail,
    required this.onSelect,
  });

  final String name;
  final String detail;
  final VoidCallback onSelect;
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
    required this.entry,
    required this.highlighted,
    required this.onHover,
  });

  final _Entry entry;
  final bool highlighted;
  final VoidCallback onHover;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: entry.onSelect,
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
                    entry.name,
                    style: jpStyle(
                      size: 15,
                      weight: FontWeight.w700,
                      color: c.ink,
                    ),
                  ),
                  if (entry.detail.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      entry.detail,
                      style: jpStyle(
                        size: 12.5,
                        weight: FontWeight.w500,
                        color: c.ink2,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
