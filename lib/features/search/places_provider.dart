import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/place_prediction.dart';
import '../../core/services/places_service.dart';
import '../../core/services/reverse_geocoding_service.dart';

enum SearchStatus { idle, loading, success, error }

class SearchState {
  const SearchState({
    this.status = SearchStatus.idle,
    this.suggestions = const [],
    this.errorMessage,
  });

  final SearchStatus status;
  final List<PlacePrediction> suggestions;
  final String? errorMessage;

  SearchState copyWith({
    SearchStatus? status,
    List<PlacePrediction>? suggestions,
    String? errorMessage,
  }) => SearchState(
    status: status ?? this.status,
    suggestions: suggestions ?? this.suggestions,
    errorMessage: errorMessage,
  );
}

class PlacesNotifier extends Notifier<SearchState> {
  Timer? _debounce;

  /// 検索ごとに増やすリクエスト世代。逆ジオは遅れて返るため、新しい検索が
  /// 始まった後に古い結果で state を上書きしないよう世代一致を確認する。
  int _generation = 0;

  @override
  SearchState build() {
    ref.onDispose(() => _debounce?.cancel());
    return const SearchState();
  }

  void search(String query) {
    _debounce?.cancel();
    _generation++;
    if (query.isEmpty) {
      state = const SearchState();
      return;
    }
    state = state.copyWith(status: SearchStatus.loading, suggestions: []);
    final gen = _generation;
    _debounce = Timer(
      const Duration(milliseconds: 400),
      () => _fetch(query, gen),
    );
  }

  Future<void> _fetch(String query, int gen) async {
    try {
      final service = ref.read(placesServiceProvider);
      final results = await service.autocomplete(query);
      if (gen != _generation) return;
      state = state.copyWith(
        status: SearchStatus.success,
        suggestions: results,
      );
      await _augmentWithAreas(results, gen);
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

  /// 同名が衝突した候補だけ逆ジオで「県＋市区町村」を補う。
  ///
  /// 全件逆引きは負荷が重いので、`name` が重複したグループのうち座標を持つ
  /// 候補にのみ問い合わせる。表ロード失敗（service が null）や逆ジオ失敗時は
  /// 何もせず、検索結果はそのまま維持する。
  Future<void> _augmentWithAreas(List<PlacePrediction> results, int gen) async {
    final service = ref.read(reverseGeocodingServiceProvider);
    if (service == null) return;

    final counts = <String, int>{};
    for (final r in results) {
      counts[r.name] = (counts[r.name] ?? 0) + 1;
    }
    final colliding = results
        .where((r) => (counts[r.name] ?? 0) > 1 && r.latLng != null)
        .toList();
    if (colliding.isEmpty) return;

    final labels = <String, String>{};
    for (final r in colliding) {
      final area = await service.areaForCoord(r.latLng!);
      if (area != null) labels[r.placeId] = area.full;
    }
    if (gen != _generation || labels.isEmpty) return;

    final updated = [
      for (final r in results)
        labels.containsKey(r.placeId) ? r.withAreaLabel(labels[r.placeId]) : r,
    ];
    state = state.copyWith(status: SearchStatus.success, suggestions: updated);
  }
}

final placesProvider = NotifierProvider<PlacesNotifier, SearchState>(
  PlacesNotifier.new,
);
