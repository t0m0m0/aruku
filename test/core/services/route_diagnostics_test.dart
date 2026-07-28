import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart';
import 'package:aruku/core/services/route_diagnostics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

RouteSegment _walk(int minutes, {String from = '', String to = ''}) =>
    RouteSegment(
      type: SegmentType.walk,
      fromName: from,
      toName: to,
      minutes: minutes,
    );

RouteSegment _train(
  int minutes, {
  String from = '',
  String to = '',
  String? line,
}) => RouteSegment(
  type: SegmentType.train,
  fromName: from,
  toName: to,
  minutes: minutes,
  line: line,
  // depTime を持たせないことで maxBoardingWait/firstMissedTransit の対象外にし、
  // 整形テストを時刻計算に依存させない（時刻付き電車の挙動は選定側テストが担保）。
  polyline: const [GeoPoint(35.0, 139.0), GeoPoint(35.1, 139.1)],
);

void main() {
  const diag = RouteDiagnostics();

  group('segSummary', () {
    test('徒歩区間は walk{分}m 形式', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(12)]);
      expect(diag.segSummary(c), 'walk12m');
    });

    test('電車区間は路線名付き {line}_train{分}m、区間は + 連結', () {
      final c = RouteCandidate(
        from: 'A',
        to: 'B',
        segments: [
          _walk(12),
          _train(33, line: '蒲12'),
          _walk(3),
        ],
      );
      expect(diag.segSummary(c), 'walk12m+蒲12_train33m+walk3m');
    });

    test('路線名が無い電車区間は train へフォールバック', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_train(20)]);
      expect(diag.segSummary(c), 'train_train20m');
    });
  });

  group('candLine', () {
    test('徒歩のみ候補は walk/arr/slack/within/maxWait/missed/構成を1行に詰める', () {
      final departureAt = DateTime(2026, 6, 27, 9, 0);
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(40)]);
      expect(
        diag.candLine(c, 60, departureAt),
        'walk=40m arr=40m slack=20m within=true maxWait=0m '
        'missed=false [walk40m]',
      );
    });

    test('予算超過は within=false・slack が負になる', () {
      final departureAt = DateTime(2026, 6, 27, 9, 0);
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(80)]);
      expect(
        diag.candLine(c, 60, departureAt),
        'walk=80m arr=80m slack=-20m within=false maxWait=0m '
        'missed=false [walk80m]',
      );
    });
  });

  group('ProbeLatencyLedger', () {
    test('ラウンド壁時計は「最遅プローブ」で、直列版は walk+guidance を足す', () {
      final l = ProbeLatencyLedger()
        ..record(walkMs: 1000, guidanceMs: 9000)
        ..record(walkMs: 3000, guidanceMs: 8000);
      // 直列（現状）: max(1000+9000, 3000+8000) = 11000
      expect(l.serialMs, 11000);
      // 並列（walk を guidance と同時発行した下限）: max(max(1000,9000), max(3000,8000)) = 9000
      expect(l.parallelMs, 9000);
    });

    test('ラウンドは直列に積むので複数ラウンドは和', () {
      final l = ProbeLatencyLedger()
        ..record(walkMs: 1000, guidanceMs: 9000)
        ..endRound()
        ..record(walkMs: 2000, guidanceMs: 5000);
      expect(l.serialMs, 10000 + 7000);
      expect(l.parallelMs, 9000 + 5000);
    });

    test('プローブの無いラウンドは 0 として無視される', () {
      // onRound はラウンド**開始時**に呼ばれるため、1本目の endRound は必ず空になる。
      final l = ProbeLatencyLedger()
        ..endRound()
        ..record(walkMs: 1000, guidanceMs: 9000);
      expect(l.serialMs, 10000);
      expect(l.parallelMs, 9000);
    });

    test('末尾の endRound を呼ばなくても進行中ラウンドは含まれる', () {
      // 締切打ち切り（shouldContinue）は while を break で抜けるため、末尾フラッシュを
      // 呼び出し側の義務にすると最後のラウンドが静かに落ちる。
      final l = ProbeLatencyLedger()..record(walkMs: 500, guidanceMs: 4000);
      expect(l.serialMs, 4500);
      expect(l.parallelMs, 4000);
    });

    test('徒歩がキャッシュヒットしたプローブは guidance だけが壁時計', () {
      final l = ProbeLatencyLedger()..record(walkMs: 0, guidanceMs: 9000);
      expect(l.serialMs, 9000);
      expect(l.parallelMs, 9000);
    });

    test('1件も記録しなければ両方 0', () {
      final l = ProbeLatencyLedger();
      expect(l.serialMs, 0);
      expect(l.parallelMs, 0);
    });

    test('parallelMs は serialMs を超えない（削減可能量が負にならない）', () {
      final l = ProbeLatencyLedger()
        ..record(walkMs: 7000, guidanceMs: 1000)
        ..record(walkMs: 1000, guidanceMs: 7000)
        ..endRound()
        ..record(walkMs: 2500, guidanceMs: 2500);
      expect(l.parallelMs, lessThanOrEqualTo(l.serialMs));
    });
  });

  group('EnrichLatencyLedger', () {
    test('パスは直列・候補は並列なので、パスごとの最遅候補を足す', () {
      final l = EnrichLatencyLedger()
        ..record(chainMs: 20000, resolveSteps: 1)
        ..record(chainMs: 38000, resolveSteps: 2)
        ..endPass()
        ..record(chainMs: 19000, resolveSteps: 1);
      expect(l.criticalPathMs, 38000 + 19000);
      expect(l.passes, 2);
      expect(l.candidates, 3);
      // 段数は「1候補が直列に積んだ guidance の最大」——パスをまたいで足さない。
      expect(l.resolveDepth, 2);
    });

    test('候補の無いパスは本数に数えない', () {
      // 先行実測が発火しない検索では endPass だけが先に来る。
      final l = EnrichLatencyLedger()
        ..endPass()
        ..record(chainMs: 5000, resolveSteps: 0);
      expect(l.passes, 1);
      expect(l.criticalPathMs, 5000);
    });

    test('末尾の endPass を呼ばなくても進行中パスは含まれる', () {
      final l = EnrichLatencyLedger()..record(chainMs: 7000, resolveSteps: 3);
      expect(l.criticalPathMs, 7000);
      expect(l.passes, 1);
      expect(l.resolveDepth, 3);
    });

    test('引き直し0段（標準乗換のみ）でも候補と時間は数える', () {
      // 実 depTime を持つ候補は _resolveBoardingTimes が即抜けるので段数0。
      // それでも徒歩 enrich の時間は払っているため chain は残る。
      final l = EnrichLatencyLedger()..record(chainMs: 1500, resolveSteps: 0);
      expect(l.resolveDepth, 0);
      expect(l.criticalPathMs, 1500);
      expect(l.candidates, 1);
    });

    test('1件も測らなければすべて0', () {
      final l = EnrichLatencyLedger();
      expect(l.criticalPathMs, 0);
      expect(l.passes, 0);
      expect(l.candidates, 0);
      expect(l.resolveDepth, 0);
    });
  });

  group('BestEffortLedger', () {
    test('プール解決とループ再試行を分けて数える', () {
      final l = BestEffortLedger()
        ..enter()
        ..recordPool(candidates: 19, resolveDepth: 2)
        ..recordRetry()
        ..recordRetry()
        ..addMs(41000);
      expect(l.entries, 1);
      expect(l.candidates, 19, reason: '短リスト上限に縛られないファンアウト幅');
      expect(l.resolveDepth, 2);
      expect(l.retries, 2, reason: 'ループは直列なので段数として効く');
      expect(l.totalMs, 41000);
    });

    test('複数回入っても足し合わせる（縮退→バス→再帰で2度通る）', () {
      final l = BestEffortLedger()
        ..enter()
        ..recordPool(candidates: 19, resolveDepth: 1)
        ..addMs(30000)
        ..enter()
        ..recordPool(candidates: 24, resolveDepth: 3)
        ..recordRetry()
        ..addMs(12000);
      expect(l.entries, 2);
      // 入る回数ぶんは直列に走るので ms と候補数は和、段数は最大。
      expect(l.candidates, 43);
      expect(l.totalMs, 42000);
      expect(l.resolveDepth, 3);
      expect(l.retries, 1);
    });

    test('一度も縮退しなければすべて0', () {
      final l = BestEffortLedger();
      expect(l.entries, 0);
      expect(l.candidates, 0);
      expect(l.resolveDepth, 0);
      expect(l.retries, 0);
      expect(l.totalMs, 0);
    });
  });

  group('RouteSearchMetrics.toLogLine', () {
    test('collapse/board-search/本数/フェーズ時間を安定した key=value 行にする', () {
      final m = RouteSearchMetrics()
        ..collapseFired = true
        ..boardSearchActivated = true
        ..singlePassMeasure = true
        ..guidanceCalls = 3
        ..guidanceDupCalls = 1
        ..walkCalls = 10
        ..matrixCalls = 2
        ..guidanceMs = 1200
        ..hybridMs = 500
        ..enrichMs = 2600
        ..boardSearchMs = 3400
        ..boardSearchRounds = 3
        ..boardSearchScanCount = 63
        ..boardSearchBest = 25
        ..boardSearchTruncated = true
        ..boardSearchProbeFailed = true
        ..boardSearchProbeSerialMs = 21000
        ..boardSearchProbeParallelMs = 18000
        ..recordEnrich(
          EnrichLatencyLedger()
            ..record(chainMs: 12000, resolveSteps: 2)
            ..endPass()
            ..record(chainMs: 7000, resolveSteps: 1)
            ..record(chainMs: 3000, resolveSteps: 1)
            ..record(chainMs: 1000, resolveSteps: 0)
            ..record(chainMs: 900, resolveSteps: 0)
            ..record(chainMs: 800, resolveSteps: 0)
            ..record(chainMs: 700, resolveSteps: 0),
        )
        ..recordBestEffort(
          BestEffortLedger()
            ..enter()
            ..recordPool(candidates: 19, resolveDepth: 2)
            ..recordRetry()
            ..recordRetry()
            ..addMs(41000),
        )
        ..busLastResortMs = 20000
        ..finalizeMs = 300
        ..totalMs = 9000;
      expect(
        m.toLogLine(),
        'collapse=1 boardSearch=1 singlePass=1 http=15 '
        'guidanceCalls=3 walkCalls=10 matrixCalls=2 '
        'guidanceDupCalls=1 '
        'guidanceMs=1200 hybridMs=500 enrichMs=2600 boardSearchMs=3400 '
        'boardSearchRounds=3 boardSearchScanCount=63 boardSearchBest=25 '
        'boardSearchTruncated=1 boardSearchProbeFailed=1 '
        'boardSearchProbeSerialMs=21000 boardSearchProbeParallelMs=18000 '
        'enrichCriticalMs=19000 enrichPasses=2 enrichResolveDepth=2 '
        'enrichCandidates=7 '
        'bestEffortMs=41000 bestEffortEntries=1 bestEffortCandidates=19 '
        'bestEffortResolveDepth=2 bestEffortRetries=2 '
        'busLastResortMs=20000 '
        'finalizeMs=300 totalMs=9000',
      );
    });

    test('並列に走った探索の rounds は合計でなく最大（＝クリティカルパス）', () {
      // base（電車）と busBase（バス）は並列に走る（#304）。合計すると「直列に積んだ
      // 段数」という rounds の意味が壊れ、壁時計と対応しなくなる。
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25,
          BoardSearchStats()
            ..rounds = 2
            ..scanCount = 40
            ..best = 11,
        ]);
      expect(m.boardSearchRounds, 3);
    });

    test('scanCount と best は同一探索から採り、対を崩さない', () {
      // 別々の探索の値を混ぜると best/scanCount 比が実在しない値になる。
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 2
            ..scanCount = 40
            ..best = 11,
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25,
        ]);
      expect(m.boardSearchRounds, 3);
      expect(m.boardSearchScanCount, 63, reason: 'rounds 最大の探索の対を採る');
      expect(m.boardSearchBest, 25);
    });

    test('truncated は報告する対と同じ探索から採る', () {
      // 採用した境界が正常に確定しているなら、別の（短い）探索が打ち切られたことを
      // 理由に捨ててはいけない。truncated は「この best が信用できるか」の印なので、
      // best と同じ探索を指していないと有効なサンプルを落とす。
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25,
          BoardSearchStats()
            ..rounds = 1
            ..scanCount = 40
            ..best = 5
            ..truncated = true,
        ]);
      expect(m.boardSearchBest, 25);
      expect(m.boardSearchTruncated, isFalse);
    });

    test('採用した探索が打ち切られていれば truncated', () {
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25
            ..truncated = true,
          BoardSearchStats()
            ..rounds = 1
            ..scanCount = 40
            ..best = 5,
        ]);
      expect(m.boardSearchBest, 25);
      expect(m.boardSearchTruncated, isTrue);
    });

    test('probeFailed も報告する対と同じ探索から採る', () {
      // truncated と同じ理由。原因（締切／上流の失敗）は違うが、どちらも「この best が
      // 信用できるか」の印なので、best と同じ探索を指していないと判断を誤らせる。
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25,
          BoardSearchStats()
            ..rounds = 1
            ..scanCount = 40
            ..best = 5
            ..probeFailed = true,
        ]);
      expect(m.boardSearchBest, 25);
      expect(m.boardSearchProbeFailed, isFalse);
    });

    test('採用した探索で probe が上流失敗していれば probeFailed', () {
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25
            ..probeFailed = true,
        ]);
      expect(m.boardSearchProbeFailed, isTrue);
    });

    test('探索が1本も走らなければ既定のまま', () {
      final m = RouteSearchMetrics()..recordBoardSearches(const []);
      expect(m.boardSearchRounds, 0);
      expect(m.boardSearchScanCount, 0);
      expect(m.boardSearchBest, -1);
      expect(m.boardSearchTruncated, isFalse);
      expect(m.boardSearchProbeFailed, isFalse);
      expect(m.boardSearchProbeSerialMs, 0);
      expect(m.boardSearchProbeParallelMs, 0);
    });

    test('プローブ内訳も報告する対と同じ探索から採る（並列探索ぶんを足さない）', () {
      // 2系統は並列に走る（#304）ので和は壁時計と対応しない。serial/parallel を別々の
      // 探索から採ると差＝削減可能量が実在しない値になるため、対で1本から採る。
      final m = RouteSearchMetrics()
        ..recordBoardSearches([
          BoardSearchStats()
            ..rounds = 3
            ..scanCount = 63
            ..best = 25
            ..probeLatency.record(walkMs: 2000, guidanceMs: 9000),
          BoardSearchStats()
            ..rounds = 1
            ..scanCount = 40
            ..best = 5
            ..probeLatency.record(walkMs: 8000, guidanceMs: 8000),
        ]);
      expect(m.boardSearchProbeSerialMs, 11000, reason: 'rounds 最大の探索の対を採る');
      expect(m.boardSearchProbeParallelMs, 9000);
    });

    test('board-search が起動しなければ探索系は 0・境界は -1（未探索の印）', () {
      // 0 は「index 0 が境界だった」と紛れるため、未探索は -1 で表す。集計側が
      // boardSearch=0 の検索を境界分布へ混ぜないための番兵。
      final m = RouteSearchMetrics();
      expect(m.boardSearchRounds, 0);
      expect(m.boardSearchScanCount, 0);
      expect(m.boardSearchBest, -1);
    });

    test('bool は 0/1・http は本数合計として集計可能', () {
      final m = RouteSearchMetrics()
        ..guidanceCalls = 1
        ..walkCalls = 4;
      expect(m.httpRoundTrips, 5);
      expect(
        m.toLogLine(),
        'collapse=0 boardSearch=0 singlePass=0 http=5 '
        'guidanceCalls=1 walkCalls=4 matrixCalls=0 '
        'guidanceDupCalls=0 '
        'guidanceMs=0 hybridMs=0 enrichMs=0 boardSearchMs=0 '
        'boardSearchRounds=0 boardSearchScanCount=0 boardSearchBest=-1 '
        'boardSearchTruncated=0 boardSearchProbeFailed=0 '
        'boardSearchProbeSerialMs=0 boardSearchProbeParallelMs=0 '
        'enrichCriticalMs=0 enrichPasses=0 enrichResolveDepth=0 '
        'enrichCandidates=0 '
        'bestEffortMs=0 bestEffortEntries=0 bestEffortCandidates=0 '
        'bestEffortResolveDepth=0 bestEffortRetries=0 '
        'busLastResortMs=0 '
        'finalizeMs=0 totalMs=0',
      );
    });
  });

  group('logMetrics のゲート（#309 レビュー指摘: profile でも出す）', () {
    List<String?> capture(void Function() body) {
      final lines = <String?>[];
      final original = debugPrint;
      debugPrint = (message, {int? wrapWidth}) => lines.add(message);
      try {
        body();
      } finally {
        debugPrint = original;
      }
      return lines;
    }

    test('定性ログ verbose=false でも metricsEnabled=true なら指標行を出す', () {
      // 実機フィールド計測は多く profile ビルド（verbose=false）。定量指標が定性ログの
      // debug 限定フラグに縛られず出ることを固定する（縛られると profile で発火率が出ない）。
      const diag = RouteDiagnostics(verbose: false, metricsEnabled: true);
      final lines = capture(() => diag.logMetrics(RouteSearchMetrics()));
      expect(lines, hasLength(1));
      expect(lines.single, startsWith('[route-metrics] collapse=0'));
    });

    test('metricsEnabled=false（release 相当）では何も出さない', () {
      const diag = RouteDiagnostics(metricsEnabled: false);
      final lines = capture(() => diag.logMetrics(RouteSearchMetrics()));
      expect(lines, isEmpty);
    });
  });

  group('boardingStationOf', () {
    test('最初の電車区間の乗車駅名を返す', () {
      final c = RouteCandidate(
        from: 'A',
        to: 'B',
        segments: [
          _walk(5),
          _train(20, from: '蒲田', to: '品川', line: 'JK'),
          _walk(3),
        ],
      );
      expect(diag.boardingStationOf(c), '蒲田');
    });

    test('電車が無ければ ?', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(30)]);
      expect(diag.boardingStationOf(c), '?');
    });

    test('乗車駅名が空なら ?', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_train(20)]);
      expect(diag.boardingStationOf(c), '?');
    });
  });
}
