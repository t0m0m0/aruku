import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/recent_destination.dart';
import '../services/recents_repository.dart';

class RecentsNotifier extends AsyncNotifier<List<RecentDestination>> {
  @override
  Future<List<RecentDestination>> build() async {
    final repo = await ref.watch(recentsRepositoryProvider.future);
    return repo.load();
  }

  Future<void> add(RecentDestination dest) async {
    final repo = await ref.read(recentsRepositoryProvider.future);
    await repo.add(dest);
    state = AsyncData(await repo.load());
  }

  Future<void> clear() async {
    final repo = await ref.read(recentsRepositoryProvider.future);
    await repo.clear();
    state = const AsyncData([]);
  }
}

final recentsProvider =
    AsyncNotifierProvider<RecentsNotifier, List<RecentDestination>>(
      RecentsNotifier.new,
    );
