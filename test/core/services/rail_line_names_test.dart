import 'package:aruku/core/services/rail_line_names.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('railLineLabel', () {
    test('私鉄の路線記号コードを和名へ写す', () {
      expect(railLineLabel('OH'), '小田急小田原線');
      expect(railLineLabel('IN'), '京王井の頭線');
      expect(railLineLabel('KO'), '京王線');
    });

    test('既に和名のもの（JR など）はそのまま返す', () {
      expect(railLineLabel('山手線（内回り）'), '山手線（内回り）');
      expect(railLineLabel('中央線快速'), '中央線快速');
    });

    test('未知コードはそのまま返す', () {
      expect(railLineLabel('ZZ'), 'ZZ');
    });

    test('null は null', () {
      expect(railLineLabel(null), isNull);
    });
  });
}
