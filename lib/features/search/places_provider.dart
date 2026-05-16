import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/place_prediction.dart';
import '../../core/services/places_service.dart';

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

  @override
  SearchState build() {
    ref.onDispose(() => _debounce?.cancel());
    return const SearchState();
  }

  void search(String query) {
    _debounce?.cancel();
    if (query.isEmpty) {
      state = const SearchState();
      return;
    }
    state = state.copyWith(status: SearchStatus.loading, suggestions: []);
    _debounce = Timer(const Duration(milliseconds: 400), () => _fetch(query));
  }

  Future<void> _fetch(String query) async {
    try {
      final service = ref.read(placesServiceProvider);
      final results = await service.autocomplete(query);
      state = state.copyWith(
        status: SearchStatus.success,
        suggestions: results,
      );
    } on PlacesException catch (e) {
      state = state.copyWith(
        status: SearchStatus.error,
        errorMessage: '検索できませんでした (${e.status})',
      );
    } catch (_) {
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
