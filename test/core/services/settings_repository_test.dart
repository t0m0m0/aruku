import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<SettingsRepository> makeRepo() async {
    final prefs = await SharedPreferences.getInstance();
    return SettingsRepository(prefs);
  }

  test('未保存なら defaults を返す', () async {
    final repo = await makeRepo();
    expect(repo.load(), AppSettings.defaults);
  });

  test('save した設定が永続化され、別インスタンスからも読める', () async {
    final prefs = await SharedPreferences.getInstance();
    await SettingsRepository(prefs).save(
      const AppSettings(unit: DistanceUnit.miles, notificationsEnabled: false),
    );

    final loaded = SettingsRepository(prefs).load();
    expect(loaded.unit, DistanceUnit.miles);
    expect(loaded.notificationsEnabled, isFalse);
  });

  test('壊れた JSON は defaults にフォールバックする', () async {
    SharedPreferences.setMockInitialValues({'settings.v1': 'not-json'});
    final repo = await makeRepo();
    expect(repo.load(), AppSettings.defaults);
  });
}
