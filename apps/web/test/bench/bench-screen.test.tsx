import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { VerifyResult } from '../../src/bench/ab-verify';
import { BenchScreen, type BenchHooks, type VerifyHooks } from '../../src/bench/bench-screen';
import type { BenchRecord } from '../../src/bench/bench-record';

const record = (pair: string): BenchRecord => ({
  pair,
  date: '2026-10-26',
  slot: '12:00',
  ratio: 1.2,
  standardMin: 40,
  budgetMin: 48,
  metrics: { walkA: 10, walkB: 20 },
  plan: null,
  error: null,
});

/// 走らせ方を外から1歩ずつ進められる偽物。
function controllableRun() {
  let hooks: BenchHooks | null = null;
  let finish: () => void = () => {};
  const dates: Date[] = [];
  const run = (date: Date, h: BenchHooks): Promise<void> => {
    dates.push(date);
    hooks = h;
    return new Promise((resolve) => (finish = resolve));
  };
  return { run, dates, hooks: () => hooks!, finish: () => finish() };
}

const noVerify = async (): Promise<void> => {};

describe('BenchScreen', () => {
  const now = () => new Date(2026, 9, 23, 15, 0); // 金曜

  it('既定の日付は翌日以降で最も近い平日で、開始するとその日で走らせる', async () => {
    const c = controllableRun();
    render(<BenchScreen now={now} total={120} run={c.run} verify={noVerify} />);
    expect(screen.getByLabelText('走らせる日')).toHaveProperty('value', '2026-10-26');
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    expect(c.dates[0].getDate()).toEqual(26);
    await act(async () => c.finish());
  });

  it('書かれたレコードを JSONL として出し、進み具合を数える', async () => {
    const c = controllableRun();
    render(<BenchScreen now={now} total={120} run={c.run} verify={noVerify} />);
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    act(() => {
      c.hooks().write(record('p1'));
      c.hooks().write(record('p2'));
      c.hooks().onProgress(2, 120);
    });
    expect(screen.getByText('2 / 120')).toBeTruthy();
    const jsonl = (screen.getByLabelText('JSONL') as HTMLTextAreaElement).value;
    expect(jsonl.trim().split('\n').map((l) => JSON.parse(l).pair)).toEqual(['p1', 'p2']);
    await act(async () => c.finish());
  });

  it('止めると、次の検索を起こさないよう走らせ方へ伝える', async () => {
    const c = controllableRun();
    render(<BenchScreen now={now} total={120} run={c.run} verify={noVerify} />);
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    expect(c.hooks().shouldStop()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(c.hooks().shouldStop()).toBe(true);
    await act(async () => c.finish());
  });

  it('画面を離れたら走らせ方を止める', async () => {
    const c = controllableRun();
    const { unmount } = render(<BenchScreen now={now} total={120} run={c.run} verify={noVerify} />);
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    unmount();
    expect(c.hooks().shouldStop()).toBe(true);
    c.finish();
  });

  it('走らせた後、書いたレコードを照合へ渡し、結果を別の JSONL に出す', async () => {
    const c = controllableRun();
    const given: BenchRecord[][] = [];
    const verify = async (records: BenchRecord[], hooks: VerifyHooks): Promise<void> => {
      given.push(records);
      const result: VerifyResult = {
        pair: 'p1', slot: '12:00', ratio: 1.2, line: 'x', from: 'a', to: 'b',
        dep: null, arr: null, found: true, matchedLine: 'x', seen: [], error: null,
      };
      hooks.write(result);
    };
    render(<BenchScreen now={now} total={120} run={c.run} verify={verify} />);
    expect(screen.getByRole('button', { name: '照合' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    act(() => c.hooks().write(record('p1')));
    await act(async () => c.finish());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '照合' }));
    });
    expect(given[0].map((r) => r.pair)).toEqual(['p1']);
    const jsonl = (screen.getByLabelText('照合 JSONL') as HTMLTextAreaElement).value;
    expect(JSON.parse(jsonl).found).toBe(true);
  });
});
