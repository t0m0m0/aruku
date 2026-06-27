import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/services/transit_plan_parser.dart';
import 'package:flutter_test/flutter_test.dart';

// Transit API `/guidance/plan` レスポンス（実機構造に準拠）を組むヘルパ。
// - journey.legs: 時刻と路線（access/egress walk は含まず secs で持つ）。
// - map.segments: access/egress を含む全ジオメトリ。transit セグメントは
//   transit leg と同数・同順で fromPointId/toPointId が leg.from.id/to.id に一致する
//   （実機検証済み）。

Map<String, dynamic> _station(String id, String name) => {
  'id': id,
  'name': name,
};

Map<String, dynamic> _railLeg({
  required String route,
  required String fromId,
  required String fromName,
  required String toId,
  required String toName,
  required int dep,
  required int arr,
}) => {
  'kind': 'transit',
  'mode': 'rail',
  'routeName': route,
  'from': _station(fromId, fromName),
  'to': _station(toId, toName),
  'departureSecs': dep,
  'arrivalSecs': arr,
};

Map<String, dynamic> _walkLeg({
  required String fromId,
  required String fromName,
  required String toId,
  required String toName,
  required int dep,
  required int arr,
}) => {
  'kind': 'walk',
  'from': _station(fromId, fromName),
  'to': _station(toId, toName),
  'departureSecs': dep,
  'arrivalSecs': arr,
};

List<Map<String, dynamic>> _poly(List<List<double>> latLon) => [
  for (final p in latLon) {'lat': p[0], 'lon': p[1]},
];

Map<String, dynamic> _mapTransit({
  required String fromId,
  required String toId,
  required String geom,
  required List<List<double>> coords,
}) => {
  'kind': 'transit',
  'geometrySource': geom,
  'fromPointId': fromId,
  'toPointId': toId,
  'polyline': _poly(coords),
};

Map<String, dynamic> _mapWalk({
  required String fromId,
  required String toId,
  required String geom,
  required List<List<double>> coords,
}) => {
  'kind': 'walk',
  'geometrySource': geom,
  'fromPointId': fromId,
  'toPointId': toId,
  'polyline': _poly(coords),
};

Map<String, dynamic> _journey({
  required int dep,
  required int arr,
  required int dur,
  int access = 0,
  int egress = 0,
  required List<Map<String, dynamic>> legs,
}) => {
  'departureSecs': dep,
  'arrivalSecs': arr,
  'durationSecs': dur,
  'accessWalkSecs': access,
  'egressWalkSecs': egress,
  'legs': legs,
};

Map<String, dynamic> _option({
  required Map<String, dynamic> journey,
  required List<Map<String, dynamic>> segments,
}) => {
  'journey': journey,
  'map': {'points': const [], 'segments': segments},
};

Map<String, dynamic> _guidance({
  String date = '20260627',
  required List<Map<String, dynamic>> options,
}) => {
  'date': date,
  'timezone': 'Asia/Tokyo',
  'from': _station('origin', '地点(出発)'),
  'to': _station('destination', '地点(目的)'),
  'options': options,
};

void main() {
  group('stripStationRomaji', () {
    test('日本語駅名に付くローマ字サフィックスを落とす', () {
      expect(stripStationRomaji('下北沢 Shimo-kitazawa'), '下北沢');
      expect(stripStationRomaji('渋谷 Shibuya'), '渋谷');
      expect(stripStationRomaji('明大前 Meidaimae'), '明大前');
    });

    test('マクロン付きローマ字も落とす', () {
      expect(stripStationRomaji('成城学園前 Seijōgakuen-mae'), '成城学園前');
    });

    test('ローマ字を含まない名前はそのまま', () {
      expect(stripStationRomaji('新宿'), '新宿');
      expect(stripStationRomaji('地点(出発)'), '地点(出発)');
    });
  });

  group('transitSecsToJst', () {
    test('サービス日0時 + 秒の naive JST を返す', () {
      expect(transitSecsToJst('20260627', 360), DateTime(2026, 6, 27, 0, 6));
      expect(transitSecsToJst('20260627', 1260), DateTime(2026, 6, 27, 0, 21));
    });

    test('86400 超（0時跨ぎ便）は翌日へ繰り上がる', () {
      // 90000s = 25:00 → 翌日 01:00。
      expect(transitSecsToJst('20260627', 90000), DateTime(2026, 6, 28, 1, 0));
    });

    test('返り値は naive（isUtc=false）', () {
      expect(transitSecsToJst('20260627', 360)!.isUtc, isFalse);
    });

    test('date/secs が不正・null なら null', () {
      expect(transitSecsToJst(null, 360), isNull);
      expect(transitSecsToJst('2026', 360), isNull);
      expect(transitSecsToJst('20260627', null), isNull);
    });
  });

  group('parseGuidancePlan', () {
    test('単一電車（access/egress 徒歩あり）を区間へ変換する', () {
      final body = _guidance(
        options: [
          _option(
            journey: _journey(
              dep: 360,
              arr: 1260,
              dur: 1100,
              access: 120,
              egress: 60,
              legs: [
                _railLeg(
                  route: '中央線快速',
                  fromId: 'jr:Tokyo',
                  fromName: '東京',
                  toId: 'jr:Shinjuku',
                  toName: '新宿',
                  dep: 360,
                  arr: 1260,
                ),
              ],
            ),
            segments: [
              _mapWalk(
                fromId: 'origin',
                toId: 'jr:Tokyo',
                geom: 'osmWalk',
                coords: [
                  [35.6812, 139.7671],
                  [35.6813, 139.7672],
                ],
              ),
              _mapTransit(
                fromId: 'jr:Tokyo',
                toId: 'jr:Shinjuku',
                geom: 'stopOrder',
                coords: [
                  [35.6812, 139.7671],
                  [35.6916, 139.7706],
                  [35.6909, 139.7003],
                ],
              ),
              _mapWalk(
                fromId: 'jr:Shinjuku',
                toId: 'destination',
                geom: 'estimatedWalk',
                coords: [
                  [35.6909, 139.7003],
                  [35.6910, 139.7004],
                ],
              ),
            ],
          ),
        ],
      );

      final options = parseGuidancePlan(body);
      expect(options, hasLength(1));
      final o = options.single;

      // access walk → train → egress walk の順。
      expect(o.segments.map((s) => s.type), [
        SegmentType.walk,
        SegmentType.train,
        SegmentType.walk,
      ]);

      final train = o.segments[1];
      expect(train.line, '中央線快速');
      expect(train.fromName, '東京');
      expect(train.toName, '新宿');
      expect(train.minutes, 15); // (1260-360)/60
      expect(train.depTime, DateTime(2026, 6, 27, 0, 6));
      expect(train.arrTime, DateTime(2026, 6, 27, 0, 21));
      expect(train.polyline, hasLength(3));

      // access/egress の所要は journey の secs を分へ。
      expect(o.segments.first.minutes, 2); // 120s
      expect(o.segments.last.minutes, 1); // 60s

      // コリドーは transit leg ぶん。stopOrder の座標がそのまま。
      expect(o.corridors, hasLength(1));
      expect(o.corridors.single.geometrySource, 'stopOrder');
      expect(o.corridors.single.coords, hasLength(3));
      expect(o.corridors.single.legIndex, 0);
    });

    test('私鉄の路線記号コード（routeName=OH）を和名へ写す', () {
      final body = _guidance(
        options: [
          _option(
            journey: _journey(
              dep: 360,
              arr: 1260,
              dur: 900,
              legs: [
                _railLeg(
                  route: 'OH',
                  fromId: 'odakyu:Setagaya-Daita',
                  fromName: '世田谷代田 Setagaya-Daita',
                  toId: 'odakyu:Shimo-Kitazawa',
                  toName: '下北沢 Shimo-kitazawa',
                  dep: 360,
                  arr: 1260,
                ),
              ],
            ),
            segments: [
              _mapTransit(
                fromId: 'odakyu:Setagaya-Daita',
                toId: 'odakyu:Shimo-Kitazawa',
                geom: 'gtfsShape',
                coords: const [
                  [35.658, 139.661],
                  [35.661, 139.668],
                ],
              ),
            ],
          ),
        ],
      );

      final train = parseGuidancePlan(body).single.segments.single;
      expect(train.type, SegmentType.train);
      expect(train.line, '小田急小田原線');
      // 駅名はローマ字サフィックスを除いて持つ。
      expect(train.fromName, '世田谷代田');
      expect(train.toName, '下北沢');
    });

    test('乗換（電車+乗換徒歩+電車）を順序通りに変換しコリドー2本', () {
      final body = _guidance(
        options: [
          _option(
            journey: _journey(
              dep: 1260,
              arr: 3357,
              dur: 2097,
              access: 113,
              egress: 57,
              legs: [
                _railLeg(
                  route: '山手線',
                  fromId: 'ya:Shibuya',
                  fromName: '渋谷',
                  toId: 'ya:Yoyogi',
                  toName: '代々木',
                  dep: 1260,
                  arr: 1560,
                ),
                _walkLeg(
                  fromId: 'ya:Yoyogi',
                  fromName: '代々木',
                  toId: 'so:Yoyogi',
                  toName: '代々木',
                  dep: 1560,
                  arr: 1680,
                ),
                _railLeg(
                  route: '中央・総武線',
                  fromId: 'so:Yoyogi',
                  fromName: '代々木',
                  toId: 'so:Kichijoji',
                  toName: '吉祥寺',
                  dep: 1980,
                  arr: 3300,
                ),
              ],
            ),
            segments: [
              _mapWalk(
                fromId: 'origin',
                toId: 'ya:Shibuya',
                geom: 'osmWalk',
                coords: [
                  [35.6580, 139.7016],
                  [35.6585, 139.7017],
                ],
              ),
              _mapTransit(
                fromId: 'ya:Shibuya',
                toId: 'ya:Yoyogi',
                geom: 'stopOrder',
                coords: [
                  [35.6580, 139.7016],
                  [35.6645, 139.7020],
                  [35.6830, 139.7020],
                ],
              ),
              _mapWalk(
                fromId: 'ya:Yoyogi',
                toId: 'so:Yoyogi',
                geom: 'osmWalk',
                coords: [
                  [35.6830, 139.7020],
                  [35.6831, 139.7019],
                ],
              ),
              _mapTransit(
                fromId: 'so:Yoyogi',
                toId: 'so:Kichijoji',
                geom: 'stopOrder',
                coords: [
                  [35.6830, 139.7020],
                  [35.6960, 139.6260],
                  [35.7030, 139.5797],
                ],
              ),
              _mapWalk(
                fromId: 'so:Kichijoji',
                toId: 'destination',
                geom: 'estimatedWalk',
                coords: [
                  [35.7030, 139.5797],
                  [35.7031, 139.5798],
                ],
              ),
            ],
          ),
        ],
      );

      final o = parseGuidancePlan(body).single;
      expect(o.segments.map((s) => s.type), [
        SegmentType.walk, // access
        SegmentType.train, // 山手線
        SegmentType.walk, // 乗換
        SegmentType.train, // 中央総武
        SegmentType.walk, // egress
      ]);
      // 乗換徒歩の所要は leg の arr-dep（待ちは含めない）。
      expect(o.segments[2].minutes, 2); // (1680-1560)/60
      // 2 本目の電車の発車時刻は待ち後の 1980s。
      expect(o.segments[3].depTime, DateTime(2026, 6, 27, 0, 33));
      expect(o.corridors, hasLength(2));
      expect(o.corridors[0].legIndex, 0);
      expect(o.corridors[1].legIndex, 1);
    });

    test('gtfsShape はコリドー座標と geometrySource を保持する', () {
      final body = _guidance(
        options: [
          _option(
            journey: _journey(
              dep: 800,
              arr: 4000,
              dur: 3200,
              access: 30,
              egress: 30,
              legs: [
                _railLeg(
                  route: 'KO',
                  fromId: 'keio:Shinjuku',
                  fromName: '新宿',
                  toId: 'keio:Hachioji',
                  toName: '京王八王子',
                  dep: 800,
                  arr: 4000,
                ),
              ],
            ),
            segments: [
              _mapWalk(
                fromId: 'origin',
                toId: 'keio:Shinjuku',
                geom: 'osmWalk',
                coords: [
                  [35.690, 139.700],
                  [35.690, 139.699],
                ],
              ),
              _mapTransit(
                fromId: 'keio:Shinjuku',
                toId: 'keio:Hachioji',
                geom: 'gtfsShape',
                // 線路追従の密な頂点（停車駅とは無関係）。
                coords: [
                  [35.690, 139.699],
                  [35.685, 139.660],
                  [35.670, 139.520],
                  [35.660, 139.400],
                  [35.658, 139.343],
                ],
              ),
              _mapWalk(
                fromId: 'keio:Hachioji',
                toId: 'destination',
                geom: 'estimatedWalk',
                coords: [
                  [35.658, 139.343],
                  [35.6558, 139.3389],
                ],
              ),
            ],
          ),
        ],
      );

      final o = parseGuidancePlan(body).single;
      expect(o.corridors.single.geometrySource, 'gtfsShape');
      expect(o.corridors.single.coords, hasLength(5));
    });

    test('全徒歩 option は単一の徒歩区間へ畳む', () {
      final body = _guidance(
        options: [
          _option(
            journey: _journey(dep: 0, arr: 3600, dur: 3600, legs: const []),
            segments: [
              _mapWalk(
                fromId: 'origin',
                toId: 'destination',
                geom: 'osmWalk',
                coords: [
                  [35.10, 139.10],
                  [35.20, 139.20],
                ],
              ),
            ],
          ),
        ],
      );

      final o = parseGuidancePlan(body).single;
      expect(o.segments, hasLength(1));
      expect(o.segments.single.type, SegmentType.walk);
      expect(o.segments.single.minutes, 60); // 3600s
      expect(o.corridors, isEmpty);
    });

    test('options が無い・不正なら空リスト', () {
      expect(parseGuidancePlan(const {}), isEmpty);
      expect(parseGuidancePlan(const {'options': 'nope'}), isEmpty);
    });
  });
}
