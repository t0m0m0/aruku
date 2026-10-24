// 厳密走査の A/B 計測（#462）を回す、開発時だけの画面（bench.html から開く）。
//
// 本番のルート表には載せていない。載せるとガード（navigation/guard.ts）とアプリ内遷移の
// 不変条件の内側へ計測用の画面を持ち込むことになり、本番のバンドルにも入る。

import { useEffect, useRef, useState } from 'react';

import { nextWeekday } from './bench-cases';
import { wallClockDate, type BenchRecord } from './bench-record';

export interface BenchHooks {
  write(record: BenchRecord): void;
  onProgress(done: number, total: number): void;
  shouldStop(): boolean;
}

export interface BenchScreenProps {
  now: () => Date;
  total: number;
  run(date: Date, hooks: BenchHooks): Promise<void>;
}

export function BenchScreen({ now, total, run }: BenchScreenProps) {
  const [date, setDate] = useState(() => wallClockDate(nextWeekday(now())));
  const [records, setRecords] = useState<BenchRecord[]>([]);
  const [done, setDone] = useState(0);
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

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n');

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([`${jsonl}\n`], { type: 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `aruku-ab-${date}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          disabled={records.length === 0}
          onClick={download}
          className="border px-3 py-1"
        >
          JSONL を保存
        </button>
      </div>
      <p>{`${done} / ${total}`}</p>
      <label className="flex flex-col gap-1">
        JSONL
        <textarea readOnly value={jsonl} rows={16} className="border p-2 font-mono text-xs" />
      </label>
    </main>
  );
}
