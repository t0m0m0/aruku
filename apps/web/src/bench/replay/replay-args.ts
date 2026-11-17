// 再生ハーネス（#504）のコマンドライン引数。

import { dateTime } from '@aruku/engine/time';

import { benchBudgetRatios, benchSlots, type BenchSlot } from '../bench-cases';
import { syntheticMatrixDelayMs } from './synthetic-walk';

export interface ReplayArgs {
  readonly mode: 'record' | 'replay';
  readonly store: string;
  readonly out: string;
  /// 出発日（壁時計の 0 時）。照会 URL に日付が入るので、録画と同じ日を渡さないと当たらない。
  readonly date: Date;
  readonly slots: readonly BenchSlot[];
  readonly ratios: readonly number[];
  /// `OdPair.id` を絞る正規表現。null は全組。
  readonly pairs: RegExp | null;
  readonly refetchLimitMs: number | null;
  readonly urlLog: string | null;
  /// JSONL の各行に載せる版の名前。
  readonly label: string;
  /// 厳密走査に答える時刻表パックの置き場所（`pack:local` の出力）。null は厳密走査を使わない（#513）。
  readonly exactPacks: string | null;
  /// 厳密走査の応答を返すまでの遅延。既定は徒歩マトリクスの合成遅延と同じ——本番の exactWalkMax の
  /// 中で支配的なのは Google マトリクス1回の往復で、走査そのものは数 ms で終わる（#459）。
  readonly exactDelayMs: number;
}

const flags = [
  'mode',
  'store',
  'out',
  'date',
  'slots',
  'ratios',
  'pairs',
  'refetch-limit-ms',
  'url-log',
  'label',
  'exact-packs',
  'exact-delay-ms',
] as const;
type Flag = (typeof flags)[number];

export const replayUsage =
  'usage: --store <rec.json> --out <out.jsonl> --date YYYY-MM-DD ' +
  '[--mode record|replay] [--slots 12:00,22:00] [--ratios 1.2,1.5,2] [--pairs <regex>] ' +
  '[--refetch-limit-ms <ms>] [--url-log <path>] [--label <name>] ' +
  '[--exact-packs <dir>] [--exact-delay-ms <ms>]';

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const raw = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!argv[i].startsWith('--') || !(flags as readonly string[]).includes(name)) {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value: ${argv[i]}`);
    raw.set(name as Flag, value);
  }
  const required = (flag: Flag): string => {
    const value = raw.get(flag);
    if (value === undefined) throw new Error(`--${flag} is required`);
    return value;
  };

  const mode = raw.get('mode') ?? 'replay';
  if (mode !== 'record' && mode !== 'replay') throw new Error(`bad --mode: ${mode}`);
  const limit = raw.get('refetch-limit-ms');
  return {
    mode,
    store: required('store'),
    out: required('out'),
    date: parseDate(required('date')),
    slots: raw.has('slots') ? raw.get('slots')!.split(',').map(parseSlot) : benchSlots,
    ratios: raw.has('ratios') ? raw.get('ratios')!.split(',').map(parseRatio) : benchBudgetRatios,
    pairs: raw.has('pairs') ? new RegExp(raw.get('pairs')!) : null,
    refetchLimitMs: limit === undefined ? null : parseLimit(limit),
    urlLog: raw.get('url-log') ?? null,
    label: raw.get('label') ?? 'replay',
    exactPacks: raw.get('exact-packs') ?? null,
    exactDelayMs: raw.has('exact-delay-ms')
      ? parseDelay(raw.get('exact-delay-ms')!)
      : syntheticMatrixDelayMs,
  };
}

function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) throw new Error(`bad --date: ${s}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = dateTime(y, mo, d);
  if (date.getFullYear() !== y || date.getMonth() + 1 !== mo || date.getDate() !== d) {
    throw new Error(`bad --date: ${s}`);
  }
  return date;
}

function parseSlot(s: string): BenchSlot {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  const h = Number(m?.[1]);
  const min = Number(m?.[2]);
  if (m === null || h > 23 || min > 59) throw new Error(`bad --slots: ${s}`);
  return { h, m: min };
}

function parseRatio(s: string): number {
  const r = Number(s);
  if (s.trim() === '' || !Number.isFinite(r) || r <= 0) throw new Error(`bad --ratios: ${s}`);
  return r;
}

function parseLimit(s: string): number {
  const n = Number(s);
  if (!/^\d+$/.test(s) || n <= 0) throw new Error(`bad --refetch-limit-ms: ${s}`);
  return n;
}

function parseDelay(s: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`bad --exact-delay-ms: ${s}`);
  return Number(s);
}
