import 'package:aruku/core/services/sync_meta_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('初期はローカル更新時刻なし（null）', () async {
    final prefs = await SharedPreferences.getInstance();
    expect(SyncMetaRepository(prefs).localUpdatedAt, isNull);
  });

  test('markLocalChanged で時刻が記録され永続化される', () async {
    final prefs = await SharedPreferences.getInstance();
    final at = DateTime.utc(2026, 6, 8, 10);
    await SyncMetaRepository(prefs).markLocalChanged(at);

    expect(SyncMetaRepository(prefs).localUpdatedAt, at);
  });

  test('setSyncedAt で同期完了時刻を記録する', () async {
    final prefs = await SharedPreferences.getInstance();
    final at = DateTime.utc(2026, 6, 8, 11);
    await SyncMetaRepository(prefs).setSyncedAt(at);

    expect(SyncMetaRepository(prefs).lastSyncedAt, at);
  });
}
