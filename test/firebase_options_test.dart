import 'package:aruku/firebase_options.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // dart-define が渡されていればその値、渡されていなければ空文字が期待値になる。
  // これで define 名の綴りを固定しつつ、キーをリポジトリへ焼き込む変更も落とせる。
  const expectedApiKey = String.fromEnvironment('FIREBASE_WEB_API_KEY');
  const expectedAppId = String.fromEnvironment('FIREBASE_WEB_APP_ID');

  group('DefaultFirebaseOptions.web', () {
    test('apiKey と appId を dart-define から読む', () {
      expect(DefaultFirebaseOptions.web.apiKey, expectedApiKey);
      expect(DefaultFirebaseOptions.web.appId, expectedAppId);
    });

    test('android と同一の Firebase プロジェクトを指す', () {
      const android = DefaultFirebaseOptions.android;
      const web = DefaultFirebaseOptions.web;
      expect(web.projectId, android.projectId);
      expect(web.messagingSenderId, android.messagingSenderId);
      expect(web.storageBucket, android.storageBucket);
    });

    test('authDomain は自プロジェクトの既定ドメインを指す', () {
      const web = DefaultFirebaseOptions.web;
      expect(web.authDomain, '${web.projectId}.firebaseapp.com');
    });
  });
}
