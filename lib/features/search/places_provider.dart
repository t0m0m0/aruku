import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/geo_point.dart';
import '../../core/models/location_state.dart';
import '../../core/models/place_prediction.dart';
import '../../core/services/places_service.dart';
import '../../core/state/app_state.dart';

enum SearchStatus { idle, loading, success, error }

/// 検索の位置バイアスに使う現在地。位置情報が確定（許可済み）のときだけ座標を返す。
/// テストではこの provider を override して現在地を差し替える。
final currentLocationProvider = Provider<GeoPoint?>((ref) {
  final loc = ref.watch(appStateProvider).locationState;
  return loc is LocationAvailable ? loc.position : null;
});

class SearchState {
  const SearchState({
    this.status = SearchStatus.idle,
    this.suggestions = const [],
    this.errorMessage,
    this.nearby = false,
  });

  final SearchStatus status;
  final List<PlacePrediction> suggestions;
  final String? errorMessage;

  /// 「近くの店」モード（#146）。ON のとき Text Search+DISTANCE で距離昇順検索する。
  final bool nearby;

  SearchState copyWith({
    SearchStatus? status,
    List<PlacePrediction>? suggestions,
    String? errorMessage,
    bool? nearby,
  }) => SearchState(
    status: status ?? this.status,
    suggestions: suggestions ?? this.suggestions,
    errorMessage: errorMessage,
    nearby: nearby ?? this.nearby,
  );
}

class PlacesNotifier extends Notifier<SearchState> {
  Timer? _debounce;

  /// 検索ごとに増やすリクエスト世代。新しい検索が始まった後に古い結果で
  /// state を上書きしないよう、結果反映前に世代一致を確認する。
  int _generation = 0;

  /// 最後に入力されたクエリ。モード切替時に同じクエリで再検索するために保持する。
  String _query = '';

  @override
  SearchState build() {
    ref.onDispose(() => _debounce?.cancel());
    return const SearchState();
  }

  void search(String query) {
    _debounce?.cancel();
    _generation++;
    _query = query;
    if (query.isEmpty) {
      // クエリは消えてもモード（nearby）は保つ。
      state = SearchState(nearby: state.nearby);
      return;
    }
    state = state.copyWith(status: SearchStatus.loading, suggestions: []);
    final gen = _generation;
    _debounce = Timer(
      const Duration(milliseconds: 400),
      () => _fetch(query, gen),
    );
  }

  /// Autocomplete 結果を現在地からの距離（distanceMeters）昇順へ並べ替える（C案）。
  /// 距離が取れた候補を先に距離昇順、距離不明の候補は元の関連度順のまま末尾へ回す。
  List<PlacePrediction> _sortByDistance(List<PlacePrediction> items) {
    final withDist = <PlacePrediction>[];
    final without = <PlacePrediction>[];
    for (final p in items) {
      (p.distanceMeters == null ? without : withDist).add(p);
    }
    withDist.sort((a, b) => a.distanceMeters!.compareTo(b.distanceMeters!));
    return [...withDist, ...without];
  }

  /// 「近くの店」モードの切替。現在のクエリで即座に再検索して結果に反映する。
  void setNearby(bool value) {
    if (state.nearby == value) return;
    state = state.copyWith(nearby: value);
    search(_query);
  }

  Future<void> _fetch(String query, int gen) async {
    try {
      final service = ref.read(placesServiceProvider);
      final location = ref.read(currentLocationProvider);

      // 系統は常に Autocomplete（typeahead を壊さない・#146 C案）。現在地が分かるときは
      // 位置バイアスを掛け（#144）、proxy 側で origin も渡るため各候補に距離が付く。
      final raw = await service.autocomplete(query, bias: location);
      // nearby モードかつ現在地ありなら、その距離で候補を距離昇順へ再ソートする。
      // Text Search を使わないので割高 SKU も最小文字数ガードも不要。
      final results = (state.nearby && location != null)
          ? _sortByDistance(raw)
          : raw;
      if (gen != _generation) return;
      state = state.copyWith(
        status: SearchStatus.success,
        suggestions: results,
      );
    } on PlacesException catch (e) {
      if (gen != _generation) return;
      state = state.copyWith(
        status: SearchStatus.error,
        errorMessage: '検索できませんでした (${e.status})',
      );
    } catch (_) {
      if (gen != _generation) return;
      state = state.copyWith(
        status: SearchStatus.error,
        errorMessage: '検索できませんでした',
      );
    }
  }
}

final placesProvider = NotifierProvider<PlacesNotifier, SearchState>(
  PlacesNotifier.new,
);
