import 'package:aruku/core/config/firebase_options_check.dart';
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter_test/flutter_test.dart';

void main() {
  const complete = FirebaseOptions(
    apiKey: 'key',
    appId: 'app',
    messagingSenderId: 'sender',
    projectId: 'project',
  );

  test('すべて埋まっていれば欠落なし', () {
    expect(missingFirebaseOptionFields(complete), isEmpty);
  });

  test('dart-define 未注入で空になったフィールドを名前で返す', () {
    expect(
      missingFirebaseOptionFields(
        const FirebaseOptions(
          apiKey: '',
          appId: 'app',
          messagingSenderId: 'sender',
          projectId: 'project',
        ),
      ),
      ['apiKey'],
    );
    expect(
      missingFirebaseOptionFields(
        const FirebaseOptions(
          apiKey: 'key',
          appId: '',
          messagingSenderId: 'sender',
          projectId: 'project',
        ),
      ),
      ['appId'],
    );
    expect(
      missingFirebaseOptionFields(
        const FirebaseOptions(
          apiKey: '',
          appId: '',
          messagingSenderId: 'sender',
          projectId: 'project',
        ),
      ),
      ['apiKey', 'appId'],
    );
  });
}
