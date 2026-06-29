// 国土地理院（GSI）の市区町村コード表 `muni.js` から、逆ジオコーディング用の
// 変換表 `assets/muni_codes.json` を生成する。
//
// 逆ジオ API（LonLatToAddress）は `muniCd`（例: "20203"）だけを返し、県名・
// 市区町村名を返さない。この表で `muniCd -> {pref, city}` を引けるようにする。
//
// 実行:
//   dart run tool/gen_muni_table.dart
//
// muni.js の1行は次の形式:
//   GSI.MUNI_ARRAY["20203"] = '20,長野県,20203,上田市';
//   → カンマ区切りで [県コード, 県名, muniCd, 市区町村名]
//   政令市の区は '札幌市　中央区' のように全角スペースが入るため除去する。
import 'dart:convert';
import 'dart:io';

const _source = 'https://maps.gsi.go.jp/js/muni.js';
const _outPath = 'assets/muni_codes.json';

final _entry = RegExp(r'''GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']*)';''');

Future<void> main() async {
  final client = HttpClient();
  final String body;
  try {
    final req = await client.getUrl(Uri.parse(_source));
    final res = await req.close();
    if (res.statusCode != 200) {
      stderr.writeln('fetch failed: HTTP ${res.statusCode}');
      exitCode = 1;
      return;
    }
    body = await res.transform(utf8.decoder).join();
  } finally {
    client.close();
  }

  final table = <String, Map<String, String>>{};
  for (final m in _entry.allMatches(body)) {
    final muniCd = m.group(1)!;
    final fields = m.group(2)!.split(',');
    if (fields.length < 4) continue;
    final pref = fields[1].trim();
    // 全角スペース（区の区切り）と通常スペースを除去: '札幌市　中央区' -> '札幌市中央区'
    final city = fields[3].replaceAll(RegExp(r'[\s　]'), '');
    if (pref.isEmpty || city.isEmpty) continue;
    table[muniCd] = {'pref': pref, 'city': city};
  }

  if (table.isEmpty) {
    stderr.writeln('no entries parsed; aborting');
    exitCode = 1;
    return;
  }

  // キー昇順で出力し差分を決定的にする。
  final sortedKeys = table.keys.toList()..sort();
  final ordered = {for (final k in sortedKeys) k: table[k]};
  final json = const JsonEncoder.withIndent('  ').convert(ordered);
  File(_outPath).writeAsStringSync('$json\n');
  stdout.writeln('wrote ${table.length} entries to $_outPath');
}
