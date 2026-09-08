// 移植元: test/core/services/route_diagnostics_test.dart

import { describe, expect, it } from 'vitest';

import { debugPrint, setDebugPrint } from '../../src/debug-print';
import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType } from '../../src/models/route-plan';
import { RouteCandidate } from '../../src/services/hybrid-route-selector';
import {
  ArrivalWaveOutcome,
  BestEffortLedger,
  BoardSearchStats,
  EnrichLatencyLedger,
  ProbeLatencyLedger,
  RouteDiagnostics,
  RouteSearchMetrics,
} from '../../src/services/route-diagnostics';
import { dateTime } from '../../src/time';
import { cascade } from '../support/cascade';
import { single } from '../support/iterable';

const walk = (minutes: number, o: { from?: string; to?: string } = {}) =>
  new RouteSegment({
    type: SegmentType.walk,
    fromName: o.from ?? '',
    toName: o.to ?? '',
    minutes,
  });

const train = (
  minutes: number,
  o: { from?: string; to?: string; line?: string } = {},
) =>
  new RouteSegment({
    type: SegmentType.train,
    fromName: o.from ?? '',
    toName: o.to ?? '',
    minutes,
    line: o.line ?? null,
    // depTime を持たせないことで maxBoardingWait/firstMissedTransit の対象外にし、
    // 整形テストを時刻計算に依存させない（時刻付き電車の挙動は選定側テストが担保）。
    polyline: [new GeoPoint(35.0, 139.0), new GeoPoint(35.1, 139.1)],
  });

const diag = new RouteDiagnostics();

describe('segSummary', () => {
  it('徒歩区間は walk{分}m 形式', () => {
    const c = new RouteCandidate({ from: 'A', to: 'B', segments: [walk(12)] });
    expect(diag.segSummary(c)).toEqual('walk12m');
  });

  it('電車区間は路線名付き {line}_train{分}m、区間は + 連結', () => {
    const c = new RouteCandidate({
      from: 'A',
      to: 'B',
      segments: [walk(12), train(33, { line: '蒲12' }), walk(3)],
    });
    expect(diag.segSummary(c)).toEqual('walk12m+蒲12_train33m+walk3m');
  });

  it('路線名が無い電車区間は train へフォールバック', () => {
    const c = new RouteCandidate({ from: 'A', to: 'B', segments: [train(20)] });
    expect(diag.segSummary(c)).toEqual('train_train20m');
  });
});

describe('candLine', () => {
  it('徒歩のみ候補は walk/arr/slack/within/maxWait/missed/構成を1行に詰める', () => {
    const departureAt = dateTime(2026, 6, 27, 9, 0);
    const c = new RouteCandidate({ from: 'A', to: 'B', segments: [walk(40)] });
    expect(diag.candLine(c, 60, departureAt)).toEqual(
      'walk=40m arr=40m slack=20m within=true maxWait=0m ' +
        'missed=false [walk40m]',
    );
  });

  it('予算超過は within=false・slack が負になる', () => {
    const departureAt = dateTime(2026, 6, 27, 9, 0);
    const c = new RouteCandidate({ from: 'A', to: 'B', segments: [walk(80)] });
    expect(diag.candLine(c, 60, departureAt)).toEqual(
      'walk=80m arr=80m slack=-20m within=false maxWait=0m ' +
        'missed=false [walk80m]',
    );
  });
});

describe('ProbeLatencyLedger', () => {
  it('ラウンド壁時計は「最遅プローブ」で、直列版は walk+guidance を足す', () => {
    const l = new ProbeLatencyLedger();
    l.record({ walkMs: 1000, guidanceMs: 9000 });
    l.record({ walkMs: 3000, guidanceMs: 8000 });
    // 直列（現状）: max(1000+9000, 3000+8000) = 11000
    expect(l.serialMs).toEqual(11000);
    // 並列（walk を guidance と同時発行した下限）: max(max(1000,9000), max(3000,8000)) = 9000
    expect(l.parallelMs).toEqual(9000);
  });

  it('ラウンドは直列に積むので複数ラウンドは和', () => {
    const l = new ProbeLatencyLedger();
    l.record({ walkMs: 1000, guidanceMs: 9000 });
    l.endRound();
    l.record({ walkMs: 2000, guidanceMs: 5000 });
    expect(l.serialMs).toEqual(10000 + 7000);
    expect(l.parallelMs).toEqual(9000 + 5000);
  });

  it('プローブの無いラウンドは 0 として無視される', () => {
    // onRound はラウンド**開始時**に呼ばれるため、1本目の endRound は必ず空になる。
    const l = new ProbeLatencyLedger();
    l.endRound();
    l.record({ walkMs: 1000, guidanceMs: 9000 });
    expect(l.serialMs).toEqual(10000);
    expect(l.parallelMs).toEqual(9000);
  });

  it('末尾の endRound を呼ばなくても進行中ラウンドは含まれる', () => {
    // 締切打ち切り（shouldContinue）は while を break で抜けるため、末尾フラッシュを
    // 呼び出し側の義務にすると最後のラウンドが静かに落ちる。
    const l = new ProbeLatencyLedger();
    l.record({ walkMs: 500, guidanceMs: 4000 });
    expect(l.serialMs).toEqual(4500);
    expect(l.parallelMs).toEqual(4000);
  });

  it('徒歩がキャッシュヒットしたプローブは guidance だけが壁時計', () => {
    const l = new ProbeLatencyLedger();
    l.record({ walkMs: 0, guidanceMs: 9000 });
    expect(l.serialMs).toEqual(9000);
    expect(l.parallelMs).toEqual(9000);
  });

  it('1件も記録しなければ両方 0', () => {
    const l = new ProbeLatencyLedger();
    expect(l.serialMs).toEqual(0);
    expect(l.parallelMs).toEqual(0);
  });

  it('parallelMs は serialMs を超えない（削減可能量が負にならない）', () => {
    const l = new ProbeLatencyLedger();
    l.record({ walkMs: 7000, guidanceMs: 1000 });
    l.record({ walkMs: 1000, guidanceMs: 7000 });
    l.endRound();
    l.record({ walkMs: 2500, guidanceMs: 2500 });
    expect(l.parallelMs).toBeLessThanOrEqual(l.serialMs);
  });
});

describe('EnrichLatencyLedger', () => {
  it('パスは直列・候補は並列なので、パスごとの最遅候補を足す', () => {
    const l = new EnrichLatencyLedger();
    l.record({ chainMs: 20000, walkMs: 5000, resolveSteps: 1 });
    l.record({ chainMs: 38000, walkMs: 9500, resolveSteps: 2 });
    l.endPass();
    l.record({ chainMs: 19000, walkMs: 4750, resolveSteps: 1 });
    expect(l.criticalPathMs).toEqual(38000 + 19000);
    expect(l.passes).toEqual(2);
    expect(l.candidates).toEqual(3);
    // 段数は「1候補が直列に積んだ guidance の最大」——パスをまたいで足さない。
    expect(l.resolveDepth).toEqual(2);
  });

  it('徒歩の内訳は最遅候補と対で採る（対を崩さない）', () => {
    // 臨界パスは最遅候補の連鎖なので、内訳もその候補から採らないと「別の候補の徒歩」を
    // 臨界パスの内訳として読むことになる。max(walkMs) で実装すると 11000 が返って落ちる。
    const l = new EnrichLatencyLedger();
    l.record({ chainMs: 30000, walkMs: 4000, resolveSteps: 1 });
    l.record({ chainMs: 12000, walkMs: 11000, resolveSteps: 1 });
    expect(l.criticalPathMs).toEqual(30000);
    expect(l.walkPathMs).toEqual(4000);
  });

  it('徒歩の内訳もパスごとに積む', () => {
    const l = new EnrichLatencyLedger();
    l.record({ chainMs: 30000, walkMs: 4000, resolveSteps: 1 });
    l.endPass();
    l.record({ chainMs: 20000, walkMs: 9000, resolveSteps: 1 });
    expect(l.criticalPathMs).toEqual(50000);
    expect(l.walkPathMs).toEqual(13000);
  });

  it('徒歩の内訳は臨界パスを超えない（引き直しぶんが負にならない）', () => {
    const l = new EnrichLatencyLedger();
    l.record({ chainMs: 30000, walkMs: 4000, resolveSteps: 1 });
    l.endPass();
    l.record({ chainMs: 20000, walkMs: 9000, resolveSteps: 1 });
    expect(l.walkPathMs).toBeLessThanOrEqual(l.criticalPathMs);
  });

  it('候補の無いパスは本数に数えない', () => {
    // 先行実測が発火しない検索では endPass だけが先に来る。
    const l = new EnrichLatencyLedger();
    l.endPass();
    l.record({ chainMs: 5000, walkMs: 1250, resolveSteps: 0 });
    expect(l.passes).toEqual(1);
    expect(l.criticalPathMs).toEqual(5000);
  });

  it('末尾の endPass を呼ばなくても進行中パスは含まれる', () => {
    const l = new EnrichLatencyLedger();
    l.record({ chainMs: 7000, walkMs: 1750, resolveSteps: 3 });
    expect(l.criticalPathMs).toEqual(7000);
    expect(l.passes).toEqual(1);
    expect(l.resolveDepth).toEqual(3);
  });

  it('引き直し0段（標準乗換のみ）でも候補と時間は数える', () => {
    // 実 depTime を持つ候補は _resolveBoardingTimes が即抜けるので段数0。
    // それでも徒歩 enrich の時間は払っているため chain は残る。
    const l = new EnrichLatencyLedger();
    l.record({ chainMs: 1500, walkMs: 375, resolveSteps: 0 });
    expect(l.resolveDepth).toEqual(0);
    expect(l.criticalPathMs).toEqual(1500);
    expect(l.candidates).toEqual(1);
  });

  it('1件も測らなければすべて0', () => {
    const l = new EnrichLatencyLedger();
    expect(l.criticalPathMs).toEqual(0);
    expect(l.passes).toEqual(0);
    expect(l.candidates).toEqual(0);
    expect(l.resolveDepth).toEqual(0);
  });
});

describe('BestEffortLedger', () => {
  it('プール解決とループ再試行を分けて数える', () => {
    const l = new BestEffortLedger();
    l.enter();
    l.recordPool({ candidates: 19, resolveDepth: 2 });
    l.recordRetry();
    l.recordRetry();
    l.addMs(41000);
    expect(l.entries).toEqual(1);
    expect(l.candidates, '短リスト上限に縛られないファンアウト幅').toEqual(19);
    expect(l.resolveDepth).toEqual(2);
    expect(l.retries, 'ループは直列なので段数として効く').toEqual(2);
    expect(l.totalMs).toEqual(41000);
  });

  it('複数回入っても足し合わせる（縮退→バス→再帰で2度通る）', () => {
    const l = new BestEffortLedger();
    l.enter();
    l.recordPool({ candidates: 19, resolveDepth: 1 });
    l.addMs(30000);
    l.enter();
    l.recordPool({ candidates: 24, resolveDepth: 3 });
    l.recordRetry();
    l.addMs(12000);
    expect(l.entries).toEqual(2);
    // 入る回数ぶんは直列に走るので ms と候補数は和、段数は最大。
    expect(l.candidates).toEqual(43);
    expect(l.totalMs).toEqual(42000);
    expect(l.resolveDepth).toEqual(3);
    expect(l.retries).toEqual(1);
  });

  it('一度も縮退しなければすべて0', () => {
    const l = new BestEffortLedger();
    expect(l.entries).toEqual(0);
    expect(l.candidates).toEqual(0);
    expect(l.resolveDepth).toEqual(0);
    expect(l.retries).toEqual(0);
    expect(l.totalMs).toEqual(0);
  });
});

describe('board-search の徒歩推移（打ち切り判断の材料）', () => {
  it('ラウンドごとの「予算内の最大徒歩」を推移として畳む', () => {
    // 「ラウンド N で止めたら徒歩が短くなるか」を直接読むための系列。頭打ちの位置が
    // そのまま打ち切ってよいラウンドになる。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 57;
        s.best = 37;
        s.walkByRound.push(23, 72, 72);
      }),
    ]);
    expect(m.boardSearchWalkByRound).toEqual([23, 72, 72]);
  });

  it('推移も報告する対と同じ探索から採る', () => {
    // 別探索の系列を混ぜると、rounds と長さが合わない実在しない推移になる。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 1;
        s.scanCount = 10;
        s.best = 2;
        s.walkByRound.push(9);
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 57;
        s.best = 37;
        s.walkByRound.push(23, 72, 72);
      }),
    ]);
    expect(m.boardSearchRounds).toEqual(3);
    expect(m.boardSearchWalkByRound).toEqual([23, 72, 72]);
  });

  it('board-search が走らなければ空', () => {
    expect(new RouteSearchMetrics().boardSearchWalkByRound).toHaveLength(0);
  });
});

describe('RouteSearchMetrics.toLogLine', () => {
  it('collapse/board-search/本数/フェーズ時間を安定した key=value 行にする', () => {
    const m = new RouteSearchMetrics();
    m.collapseFired = true;
    m.boardSearchActivated = true;
    m.singlePassMeasure = true;
    m.guidanceCalls = 3;
    m.guidanceDupCalls = 1;
    m.walkCalls = 10;
    m.matrixCalls = 2;
    m.arrivalWaveOutcome = ArrivalWaveOutcome.ok;
    m.arrivalWaveOptions = 2;
    m.arrivalWaveBaseUsed = true;
    m.arrivalWaveWon = true;
    m.guidanceMs = 1200;
    m.hybridMs = 500;
    m.enrichMs = 2600;
    m.boardSearchMs = 3400;
    m.boardSearchRounds = 3;
    m.boardSearchScanCount = 63;
    m.boardSearchBest = 25;
    m.boardSearchTruncated = true;
    m.boardSearchProbeFailed = true;
    m.boardSearchProbeSerialMs = 21000;
    m.boardSearchProbeParallelMs = 18000;
    m.boardSearchSpeculated = true;
    m.recordSpeculationWaste(
      cascade(new BoardSearchStats(), (s) => {
        s.probes = 7;
      }),
    );
    m.recordEnrich(
      cascade(new EnrichLatencyLedger(), (l) => {
        l.record({ chainMs: 12000, walkMs: 3000, resolveSteps: 2 });
        l.endPass();
        l.record({ chainMs: 7000, walkMs: 1750, resolveSteps: 1 });
        l.record({ chainMs: 3000, walkMs: 750, resolveSteps: 1 });
        l.record({ chainMs: 1000, walkMs: 250, resolveSteps: 0 });
        l.record({ chainMs: 900, walkMs: 225, resolveSteps: 0 });
        l.record({ chainMs: 800, walkMs: 200, resolveSteps: 0 });
        l.record({ chainMs: 700, walkMs: 175, resolveSteps: 0 });
      }),
    );
    m.recordBestEffort(
      cascade(new BestEffortLedger(), (l) => {
        l.enter();
        l.recordPool({ candidates: 19, resolveDepth: 2 });
        l.recordRetry();
        l.recordRetry();
        l.addMs(41000);
      }),
    );
    m.busLastResortMs = 20000;
    m.boardSearchWinnerRound = 2;
    m.finalWalkMinutes = 78;
    m.finalizeMs = 300;
    m.totalMs = 9000;
    expect(m.toLogLine()).toEqual(
      'collapse=1 boardSearch=1 singlePass=1 http=15 ' +
        'guidanceCalls=3 walkCalls=10 matrixCalls=2 ' +
        'guidanceDupCalls=1 ' +
        'arrivalWaveOutcome=0 arrivalWaveOptions=2 ' +
        'arrivalWaveBaseUsed=1 arrivalWaveWon=1 ' +
        'guidanceMs=1200 hybridMs=500 enrichMs=2600 boardSearchMs=3400 ' +
        'boardSearchRounds=3 boardSearchScanCount=63 boardSearchBest=25 ' +
        'boardSearchTruncated=1 boardSearchProbeFailed=1 ' +
        'boardSearchProbeSerialMs=21000 boardSearchProbeParallelMs=18000 ' +
        'boardSearchSpeculated=1 boardSearchSpeculationWasted=1 ' +
        'boardSearchSpeculationProbes=7 ' +
        'enrichCriticalMs=19000 enrichWalkMs=4750 enrichPasses=2 enrichResolveDepth=2 ' +
        'enrichCandidates=7 ' +
        'bestEffortMs=41000 bestEffortEntries=1 bestEffortCandidates=19 ' +
        'bestEffortResolveDepth=2 bestEffortRetries=2 ' +
        'busLastResortMs=20000 ' +
        'boardSearchWalkByRound=- boardSearchWinnerRound=2 ' +
        'finalWalkMinutes=78 ' +
        'finalizeMs=300 totalMs=9000',
    );
  });

  it('並列に走った探索の rounds は合計でなく最大（＝クリティカルパス）', () => {
    // base（電車）と busBase（バス）は並列に走る（#304）。合計すると「直列に積んだ
    // 段数」という rounds の意味が壊れ、壁時計と対応しなくなる。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 2;
        s.scanCount = 40;
        s.best = 11;
      }),
    ]);
    expect(m.boardSearchRounds).toEqual(3);
  });

  it('scanCount と best は同一探索から採り、対を崩さない', () => {
    // 別々の探索の値を混ぜると best/scanCount 比が実在しない値になる。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 2;
        s.scanCount = 40;
        s.best = 11;
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
      }),
    ]);
    expect(m.boardSearchRounds).toEqual(3);
    expect(m.boardSearchScanCount, 'rounds 最大の探索の対を採る').toEqual(63);
    expect(m.boardSearchBest).toEqual(25);
  });

  it('truncated は報告する対と同じ探索から採る', () => {
    // 採用した境界が正常に確定しているなら、別の（短い）探索が打ち切られたことを
    // 理由に捨ててはいけない。truncated は「この best が信用できるか」の印なので、
    // best と同じ探索を指していないと有効なサンプルを落とす。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 1;
        s.scanCount = 40;
        s.best = 5;
        s.truncated = true;
      }),
    ]);
    expect(m.boardSearchBest).toEqual(25);
    expect(m.boardSearchTruncated).toBe(false);
  });

  it('採用した探索が打ち切られていれば truncated', () => {
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
        s.truncated = true;
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 1;
        s.scanCount = 40;
        s.best = 5;
      }),
    ]);
    expect(m.boardSearchBest).toEqual(25);
    expect(m.boardSearchTruncated).toBe(true);
  });

  it('probeFailed も報告する対と同じ探索から採る', () => {
    // truncated と同じ理由。原因（締切／上流の失敗）は違うが、どちらも「この best が
    // 信用できるか」の印なので、best と同じ探索を指していないと判断を誤らせる。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 1;
        s.scanCount = 40;
        s.best = 5;
        s.probeFailed = true;
      }),
    ]);
    expect(m.boardSearchBest).toEqual(25);
    expect(m.boardSearchProbeFailed).toBe(false);
  });

  it('採用した探索で probe が上流失敗していれば probeFailed', () => {
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
        s.probeFailed = true;
      }),
    ]);
    expect(m.boardSearchProbeFailed).toBe(true);
  });

  it('探索が1本も走らなければ既定のまま', () => {
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([]);
    expect(m.boardSearchRounds).toEqual(0);
    expect(m.boardSearchScanCount).toEqual(0);
    expect(m.boardSearchBest).toEqual(-1);
    expect(m.boardSearchTruncated).toBe(false);
    expect(m.boardSearchProbeFailed).toBe(false);
    expect(m.boardSearchProbeSerialMs).toEqual(0);
    expect(m.boardSearchProbeParallelMs).toEqual(0);
  });

  it('プローブ内訳も報告する対と同じ探索から採る（並列探索ぶんを足さない）', () => {
    // 2系統は並列に走る（#304）ので和は壁時計と対応しない。serial/parallel を別々の
    // 探索から採ると差＝削減可能量が実在しない値になるため、対で1本から採る。
    const m = new RouteSearchMetrics();
    m.recordBoardSearches([
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 3;
        s.scanCount = 63;
        s.best = 25;
        s.probeLatency.record({ walkMs: 2000, guidanceMs: 9000 });
      }),
      cascade(new BoardSearchStats(), (s) => {
        s.rounds = 1;
        s.scanCount = 40;
        s.best = 5;
        s.probeLatency.record({ walkMs: 8000, guidanceMs: 8000 });
      }),
    ]);
    expect(m.boardSearchProbeSerialMs, 'rounds 最大の探索の対を採る').toEqual(
      11000,
    );
    expect(m.boardSearchProbeParallelMs).toEqual(9000);
  });

  it('board-search が起動しなければ探索系は 0・境界は -1（未探索の印）', () => {
    // 0 は「index 0 が境界だった」と紛れるため、未探索は -1 で表す。集計側が
    // boardSearch=0 の検索を境界分布へ混ぜないための番兵。
    const m = new RouteSearchMetrics();
    expect(m.boardSearchRounds).toEqual(0);
    expect(m.boardSearchScanCount).toEqual(0);
    expect(m.boardSearchBest).toEqual(-1);
  });

  it('bool は 0/1・http は本数合計として集計可能', () => {
    const m = new RouteSearchMetrics();
    m.guidanceCalls = 1;
    m.walkCalls = 4;
    expect(m.httpRoundTrips).toEqual(5);
    expect(m.toLogLine()).toEqual(
      'collapse=0 boardSearch=0 singlePass=0 http=5 ' +
        'guidanceCalls=1 walkCalls=4 matrixCalls=0 ' +
        'guidanceDupCalls=0 ' +
        'arrivalWaveOutcome=-1 arrivalWaveOptions=0 ' +
        'arrivalWaveBaseUsed=0 arrivalWaveWon=0 ' +
        'guidanceMs=0 hybridMs=0 enrichMs=0 boardSearchMs=0 ' +
        'boardSearchRounds=0 boardSearchScanCount=0 boardSearchBest=-1 ' +
        'boardSearchTruncated=0 boardSearchProbeFailed=0 ' +
        'boardSearchProbeSerialMs=0 boardSearchProbeParallelMs=0 ' +
        'boardSearchSpeculated=0 boardSearchSpeculationWasted=0 ' +
        'boardSearchSpeculationProbes=0 ' +
        'enrichCriticalMs=0 enrichWalkMs=0 enrichPasses=0 enrichResolveDepth=0 ' +
        'enrichCandidates=0 ' +
        'bestEffortMs=0 bestEffortEntries=0 bestEffortCandidates=0 ' +
        'bestEffortResolveDepth=0 bestEffortRetries=0 ' +
        'busLastResortMs=0 ' +
        'boardSearchWalkByRound=- boardSearchWinnerRound=-1 ' +
        'finalWalkMinutes=-1 ' +
        'finalizeMs=0 totalMs=0',
    );
  });

  it('到着波の結末は4値のコードとして1行ログに出る (#376)', () => {
    // 集計器（tool/route_metrics_agg.dart）は key=<int> しか読まないので、内訳は
    // 文字列ではなくコードで出す。値の対応が動くと過去ログの集計が黙って狂うため固定する。
    const codeOf = (o: ArrivalWaveOutcome): number => {
      const line = cascade(new RouteSearchMetrics(), (m) => {
        m.arrivalWaveOutcome = o;
      }).toLogLine();
      return Number.parseInt(
        /arrivalWaveOutcome=(-?\d+)/.exec(line)![1],
        10,
      );
    };

    expect(codeOf(ArrivalWaveOutcome.ok)).toEqual(0);
    expect(codeOf(ArrivalWaveOutcome.timeout)).toEqual(1);
    expect(codeOf(ArrivalWaveOutcome.error)).toEqual(2);
    expect(codeOf(ArrivalWaveOutcome.empty)).toEqual(3);
  });

  it('第2波を待つ前の未確定は実際の結末と別のコードで出る (#376)', () => {
    // -1 は同ログ行の boardSearchBest / finalWalkMinutes と同じ「該当なし」の流儀。
    // 0（ok）に倒すと、器を作っただけの検索が成功として集計に混ざる。
    expect(new RouteSearchMetrics().toLogLine()).toContain(
      'arrivalWaveOutcome=-1',
    );
  });
});

describe('RouteSearchMetrics: 投機 board-search の空振り計上 (#341)', () => {
  it('空振りの対価は壁時計ではなく打ち上げた probe 本数で計上する', () => {
    // 投機は enrich と並行に走るので、捨てた探索がユーザーに払わせた壁時計はほぼ 0。
    // 実際に消えるのは上流（第三者 API・§2.1）の枠なので、対価の単位は往復本数になる。
    const m = new RouteSearchMetrics();
    m.boardSearchSpeculated = true;
    m.recordSpeculationWaste(
      cascade(new BoardSearchStats(), (s) => {
        s.probes = 5;
      }),
    );
    expect(m.boardSearchSpeculationWasted).toBe(true);
    expect(m.boardSearchSpeculationProbes).toEqual(5);
  });

  it('投機しただけで空振りしていなければ wasted は立たない', () => {
    const m = new RouteSearchMetrics();
    m.boardSearchSpeculated = true;
    expect(m.boardSearchSpeculationWasted).toBe(false);
    expect(m.boardSearchSpeculationProbes).toEqual(0);
  });

  it('投機していない検索は3フィールドとも既定のまま', () => {
    const m = new RouteSearchMetrics();
    expect(m.boardSearchSpeculated).toBe(false);
    expect(m.boardSearchSpeculationWasted).toBe(false);
    expect(m.boardSearchSpeculationProbes).toEqual(0);
  });

  it('BoardSearchStats.probes の既定は 0', () => {
    expect(new BoardSearchStats().probes).toEqual(0);
  });
});

describe('logMetrics のゲート（#309 レビュー指摘: profile でも出す）', () => {
  const capture = (body: () => void): (string | null)[] => {
    const lines: (string | null)[] = [];
    const original = debugPrint;
    setDebugPrint((message) => {
      lines.push(message);
    });
    try {
      body();
    } finally {
      setDebugPrint(original);
    }
    return lines;
  };

  it('定性ログ verbose=false でも metricsEnabled=true なら指標行を出す', () => {
    // 実機フィールド計測は多く profile ビルド（verbose=false）。定量指標が定性ログの
    // debug 限定フラグに縛られず出ることを固定する（縛られると profile で発火率が出ない）。
    const d = new RouteDiagnostics({ verbose: false, metricsEnabled: true });
    const lines = capture(() => d.logMetrics(new RouteSearchMetrics()));
    expect(lines).toHaveLength(1);
    expect(single(lines)!.startsWith('[route-metrics] collapse=0')).toBe(true);
  });

  it('metricsEnabled=false（release 相当）では何も出さない', () => {
    const d = new RouteDiagnostics({ metricsEnabled: false });
    const lines = capture(() => d.logMetrics(new RouteSearchMetrics()));
    expect(lines).toHaveLength(0);
  });
});

describe('boardingStationOf', () => {
  it('最初の電車区間の乗車駅名を返す', () => {
    const c = new RouteCandidate({
      from: 'A',
      to: 'B',
      segments: [
        walk(5),
        train(20, { from: '蒲田', to: '品川', line: 'JK' }),
        walk(3),
      ],
    });
    expect(diag.boardingStationOf(c)).toEqual('蒲田');
  });

  it('電車が無ければ ?', () => {
    const c = new RouteCandidate({ from: 'A', to: 'B', segments: [walk(30)] });
    expect(diag.boardingStationOf(c)).toEqual('?');
  });

  it('乗車駅名が空なら ?', () => {
    const c = new RouteCandidate({ from: 'A', to: 'B', segments: [train(20)] });
    expect(diag.boardingStationOf(c)).toEqual('?');
  });
});
