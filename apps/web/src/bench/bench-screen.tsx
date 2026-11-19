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
  run: (date: Date, hooks: BenchHooks) => Promise<void>;
  verify: (records: BenchRecord[], hooks: VerifyHooks) => Promise<void>;
}

export function BenchScreen({ now, total, run, verify }: BenchScreenProps) {
  const [date, setDate] = useState(() => wallClockDate(nextWeekday(now())));
  const [records, setRecords] = useState<BenchRecord[]>([]);
  const [done, setDone] = useState(0);
  const [verified, setVerified] = useState<VerifyResult[]>([]);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
    };
  }, []);

  const guarded = async (task: () => Promise<void>): Promise<void> => {
    stopRef.current = false;
    setFailure(null);
    setRunning(true);
    try {
      await task();
    } catch (error) {
      if (mountedRef.current) setFailure(String(error));
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  };

  const start = (): Promise<void> => {
    setRecords([]);
    setVerified([]);
    setDone(0);
    const [y, m, d] = date.split('-').map(Number);
    return guarded(() =>
      run(new Date(y, m - 1, d), {
        write: (r) => setRecords((rs) => [...rs, r]),
        onProgress: (n) => setDone(n),
        shouldStop: () => stopRef.current,
      }),
    );
  };

  const startVerify = (): Promise<void> => {
    setVerified([]);
    return guarded(() =>
      verify(records, {
        write: (r) => setVerified((vs) => [...vs, r]),
        shouldStop: () => stopRef.current,
      }),
    );
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
      {failure !== null && (
        <p role="alert" className="text-red-700">
          {failure}
        </p>
      )}
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
