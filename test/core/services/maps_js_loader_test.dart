import 'package:aruku/core/services/maps_js_loader.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('shouldLoadMapsJs', () {
    test('Web でフラグとキーが揃ったときだけ読み込む', () {
      expect(
        shouldLoadMapsJs(isWeb: true, flagEnabled: true, apiKey: 'k'),
        isTrue,
      );
    });

    test('ネイティブでは読み込まない（SDK がキーを自前で持つ）', () {
      expect(
        shouldLoadMapsJs(isWeb: false, flagEnabled: true, apiKey: 'k'),
        isFalse,
      );
    });

    test('フラグが立っていなければ読み込まない', () {
      expect(
        shouldLoadMapsJs(isWeb: true, flagEnabled: false, apiKey: 'k'),
        isFalse,
      );
    });

    test('キーが無ければ読み込まない', () {
      expect(
        shouldLoadMapsJs(isWeb: true, flagEnabled: true, apiKey: ''),
        isFalse,
      );
      // 空白だけの値は「設定した」に見えて実質未設定なので同じ扱いにする。
      expect(
        shouldLoadMapsJs(isWeb: true, flagEnabled: true, apiKey: '   '),
        isFalse,
      );
    });
  });

  group('mapsJsUrl', () {
    test('キーを query に載せた Maps JavaScript API の URL を作る', () {
      expect(
        mapsJsUrl('abc123'),
        'https://maps.googleapis.com/maps/api/js?key=abc123',
      );
    });

    test('キーを URL エンコードする', () {
      expect(mapsJsUrl('a b&c'), endsWith('key=a%20b%26c'));
    });

    test('loading=async を付けない', () {
      // 付けると google.maps の初期化が script の onload より後になり、
      // 読み込み完了の合図として onload が使えなくなる。
      expect(mapsJsUrl('k'), isNot(contains('loading=async')));
    });

    test('libraries を付けない', () {
      // 使うのは polyline と legacy marker だけで、どちらもコアに含まれる。
      expect(mapsJsUrl('k'), isNot(contains('libraries=')));
    });
  });

  group('mapsJsLoadedProvider', () {
    test('ネイティブでは読み込みを試みず false を返す', () async {
      expect(
        await loadMapsJsIfNeeded(isWeb: false, flagEnabled: true, apiKey: 'k'),
        isFalse,
      );
    });

    test('Web でもキーが無ければ読み込みを試みない', () async {
      expect(
        await loadMapsJsIfNeeded(isWeb: true, flagEnabled: true, apiKey: ''),
        isFalse,
      );
    });
  });
}
