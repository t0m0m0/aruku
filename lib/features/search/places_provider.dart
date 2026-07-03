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

  /// 「近くの店」モード（#146）。ON のとき Autocomplete 結果を現在地からの
  /// 距離（distanceMeters）昇順へ再ソートする（系統は typeahead と同じ・C案）。
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
  /// Autocomplete は課金リクエストなので、実用性の低い短すぎるクエリでは発行しない（#162）。
  /// 日本語でも 1 文字の候補品質は低いため、2 文字以上を最小の発火条件とする。
  static const int minQueryLength = 2;

  Timer? _debounce;

  /// 検索ごとに増やすリクエスト世代。新しい検索が始まった後に古い結果で
  /// state を上書きしないよう、結果反映前に世代一致を確認する。
  int _generation = 0;

  /// 直近の取得結果（関連度順・未ソート）。距離は通常検索でも各候補に付くため、
  /// モード切替はこれを並べ替えるだけで済み、再フェッチ（課金・遅延）を避けられる。
  List<PlacePrediction> _rawSuggestions = const [];

  @override
  SearchState build() {
    ref.onDispose(() => _debounce?.cancel());
    return const SearchState();
  }

  void search(String query) {
    _debounce?.cancel();
    _generation++;
    // 空・最小文字数未満（1 文字）はフェッチせず候補をクリアする。ローディングにも
    // しない（発火しないため）。クエリが短くてもモード（nearby）は保つ。
    // 文字数は runes（コードポイント）で数え、サロゲートペアを 1 文字として扱う。
    if (query.runes.length < minQueryLength) {
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

  /// nearby モードかつ現在地ありなら距離昇順へ並べ替え、そうでなければ関連度順のまま。
  /// 取得時（_fetch）とモード切替時（setNearby）で同じ並び替え規則を共有する。
  List<PlacePrediction> _arrange(
    bool nearby,
    GeoPoint? location,
    List<PlacePrediction> raw,
  ) => (nearby && location != null) ? _sortByDistance(raw) : raw;

  /// 「近くの店」モードの切替。距離は通常検索でも各候補に付いているため、取得済みの
  /// 候補をその場で並べ替えるだけで再フェッチしない（課金リクエストと 400ms 待ちを省く）。
  /// まだ結果が無い／取得中はフラグだけ更新し、進行中の _fetch 完了時に正しい並びで反映する。
  void setNearby(bool value) {
    if (state.nearby == value) return;
    if (state.status != SearchStatus.success) {
      state = state.copyWith(nearby: value);
      return;
    }
    final location = ref.read(currentLocationProvider);
    final reordered = _arrange(value, location, _rawSuggestions);
    state = state.copyWith(nearby: value, suggestions: reordered);
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
      final results = _arrange(state.nearby, location, raw);
      if (gen != _generation) return;
      // モード切替で再フェッチせず並べ替えられるよう、関連度順の生結果を保持する。
      _rawSuggestions = raw;
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
