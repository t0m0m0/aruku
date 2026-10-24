// 厳密走査の A/B 計測（#462）を回す、開発時だけの画面（bench.html から開く）。
//
// 本番のルート表には載せていない。載せるとガード（navigation/guard.ts）とアプリ内遷移の
// 不変条件の内側へ計測用の画面を持ち込むことになり、本番のバンドルにも入る。

import { useEffect, useRef, useState } from 'react';

import type { VerifyResult } from './ab-verify';
import { nextWeekday } from './bench-cases';
import { wallClockDate, type BenchRecord } from './bench-record';

export interface BenchHooks {
  write(record: BenchRecord): void;
  onProgress(done: number, total: number): void;
  shouldStop(): boolean;
}

export interface VerifyHooks {
  write(result: VerifyResult): void;
  shouldStop(): boolean;
}

export interface BenchScreenProps {
  now: () => Date;
  total: number;
  run(date: Date, hooks: BenchHooks): Promise<void>;
  /// 厳密走査が勝った経路の便を Transit API で照合する（src/bench/ab-verify.ts）。
  verify(records: BenchRecord[], hooks: VerifyHooks): Promise<void>;
}

export function BenchScreen({ now, total, run, verify }: BenchScreenProps) {
  const [date, setDate] = useState(() => wallClockDate(nextWeekday(now())));
  const [records, setRecords] = useState<BenchRecord[]>([]);
  const [done, setDone] = useState(0);
  const [verified, setVerified] = useState<VerifyResult[]>([]);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);

  // 画面を離れた後に続きの検索が走ると、誰も受け取らない JSONL のために第三者 API を
  // 叩き続ける。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
    };
  }, []);

  const start = async (): Promise<void> => {
    stopRef.current = false;
    setRecords([]);
    setDone(0);
    setRunning(true);
    const [y, m, d] = date.split('-').map(Number);
    await run(new Date(y, m - 1, d), {
      write: (r) => setRecords((rs) => [...rs, r]),
      onProgress: (n) => setDone(n),
      shouldStop: () => stopRef.current,
    });
    if (mountedRef.current) setRunning(false);
  };

  const startVerify = async (): Promise<void> => {
    stopRef.current = false;
    setVerified([]);
    setRunning(true);
    await verify(records, {
      write: (r) => setVerified((vs) => [...vs, r]),
      shouldStop: () => stopRef.current,
    });
    if (mountedRef.current) setRunning(false);
  };

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n');
  const verifyJsonl = verified.map((r) => JSON.stringify(r)).join('\n');

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-xl font-bold">厳密走査 A/B ベンチ（#462）</h1>
      <label className="flex items-center gap-2">
        走らせる日
        <input
          type="date"
          value={date}
          disabled={running}
          onChange={(e) => setDate(e.target.value)}
          className="border px-2 py-1"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={running}
          onClick={() => void start()}
          className="border px-3 py-1"
        >
          開始
        </button>
        <button
          type="button"
          disabled={!running}
          onClick={() => {
            stopRef.current = true;
          }}
          className="border px-3 py-1"
        >
          停止
        </button>
        <button
          type="button"
          disabled={running || records.length === 0}
          onClick={() => void startVerify()}
          className="border px-3 py-1"
        >
          照合
        </button>
        <button
          type="button"
          disabled={records.length === 0}
          onClick={() => download(jsonl, `aruku-ab-${date}.jsonl`)}
          className="border px-3 py-1"
        >
          JSONL を保存
        </button>
        <button
          type="button"
          disabled={verified.length === 0}
          onClick={() => download(verifyJsonl, `aruku-ab-verify-${date}.jsonl`)}
          className="border px-3 py-1"
        >
          照合 JSONL を保存
        </button>
      </div>
      <p>{`${done} / ${total}`}</p>
      <label className="flex flex-col gap-1">
        JSONL
        <textarea readOnly value={jsonl} rows={16} className="border p-2 font-mono text-xs" />
      </label>
      <label className="flex flex-col gap-1">
        照合 JSONL
        <textarea readOnly value={verifyJsonl} rows={6} className="border p-2 font-mono text-xs" />
      </label>
    </main>
  );
}

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
