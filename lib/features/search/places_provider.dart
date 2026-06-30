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

  /// 「近くの店」モードで Text Search（割高 SKU）を叩く最小文字数。これ未満は
  /// 上流を呼ばず空結果にして課金を抑制する。
  static const _nearbyMinChars = 2;

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

      final List<PlacePrediction> results;
      // nearby モードかつ現在地ありなら Text Search+DISTANCE で距離昇順。現在地が
      // 無ければ DISTANCE の中心点が取れないため通常 typeahead へフォールバックする。
      if (state.nearby && location != null) {
        if (query.length < _nearbyMinChars) {
          if (gen != _generation) return;
          state = state.copyWith(status: SearchStatus.success, suggestions: []);
          return;
        }
        results = await service.nearbySearch(query, bias: location);
      } else {
        // 現在地が分かるときは位置バイアスを掛け、近隣 POI を上位へ寄せる（#144）。
        results = await service.autocomplete(query, bias: location);
      }
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
