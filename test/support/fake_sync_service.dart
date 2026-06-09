import 'package:aruku/core/models/sync_data.dart';
import 'package:aruku/core/services/sync_service.dart';

/// テスト用のインメモリ [SyncService]。uid ごとにスナップショットを保持する。
class FakeSyncService implements SyncService {
  final Map<String, SyncData> store = {};
  int pushCount = 0;

  @override
  Future<SyncData?> fetch(String uid) async => store[uid];

  @override
  Future<void> push(String uid, SyncData data) async {
    store[uid] = data;
    pushCount++;
  }
}
