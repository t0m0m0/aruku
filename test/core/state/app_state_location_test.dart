import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AppState.departureLabelText', () {
    AppState stateWith(LocationState loc) =>
        AppState.initial.copyWith(locationState: loc);

    test('Loading のとき「現在地 · 取得中...」を返す', () {
      expect(
        stateWith(const LocationLoading()).departureLabelText,
        '現在地 · 取得中...',
      );
    });

    test('Available のとき「現在地」を返す', () {
      expect(
        stateWith(
          const LocationAvailable(GeoPoint(35.68, 139.76)),
        ).departureLabelText,
        '現在地',
      );
    });

    test('Denied のとき「位置情報なし」を返す', () {
      expect(stateWith(const LocationDenied()).departureLabelText, '位置情報なし');
    });
  });
}
