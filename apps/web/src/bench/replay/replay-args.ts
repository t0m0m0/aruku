import { dateTime } from '@aruku/engine/time';

import { benchBudgetRatios, benchSlots, type BenchSlot } from '../bench-cases';
import { syntheticMatrixDelayMs, syntheticRouteDelayMs } from './synthetic-walk';

export interface ReplayArgs {
  readonly mode: 'record' | 'replay';
  readonly store: string;
  readonly out: string;
  readonly date: Date;
  readonly slots: readonly BenchSlot[];
  readonly ratios: readonly number[];
  readonly pairs: RegExp | null;
  readonly refetchLimitMs: number | null;
  readonly urlLog: string | null;
  readonly label: string;
  readonly exactPacks: string | null;
  readonly exactDelayMs: number;
  readonly ridePacks: string | null;
  readonly rideDelayMs: number;
  readonly rideVerify: boolean;
  readonly arrivalWave: boolean;
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
  'ride-packs',
  'ride-delay-ms',
  'ride-verify',
  'no-arrival-wave',
] as const;
type Flag = (typeof flags)[number];

function isFlag(name: string): name is Flag {
  return flags.some((flag) => flag === name);
}

export const replayUsage =
  'usage: --store <rec.json> --out <out.jsonl> --date YYYY-MM-DD ' +
  '[--mode record|replay] [--slots 12:00,22:00] [--ratios 1.2,1.5,2] [--pairs <regex>] ' +
  '[--refetch-limit-ms <ms>] [--url-log <path>] [--label <name>] ' +
  '[--exact-packs <dir>] [--exact-delay-ms <ms>] [--ride-packs <dir>] [--ride-delay-ms <ms>] [--ride-verify 1] [--no-arrival-wave 1]';

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const raw = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    const value = argv.at(i + 1);
    if (!argv[i].startsWith('--') || !isFlag(name)) {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value: ${argv[i]}`);
    raw.set(name, value);
  }
  const required = (flag: Flag): string => {
    const value = raw.get(flag);
    if (value === undefined) throw new Error(`--${flag} is required`);
    return value;
  };

  const mode = raw.get('mode') ?? 'replay';
  if (mode !== 'record' && mode !== 'replay') throw new Error(`bad --mode: ${mode}`);
  const limit = raw.get('refetch-limit-ms');
  const slots = raw.get('slots');
  const ratios = raw.get('ratios');
  const pairs = raw.get('pairs');
  const exactDelayMs = raw.get('exact-delay-ms');
  const rideDelayMs = raw.get('ride-delay-ms');
  const rideVerify = raw.get('ride-verify');
  const noArrivalWave = raw.get('no-arrival-wave');
  if (noArrivalWave !== undefined && noArrivalWave !== '1') {
    throw new Error(`bad --no-arrival-wave: ${noArrivalWave}`);
  }
  if (rideVerify !== undefined && rideVerify !== '1') {
    throw new Error(`bad --ride-verify: ${rideVerify}`);
  }
  if (rideVerify !== undefined && raw.get('ride-packs') === undefined) {
    throw new Error('--ride-verify needs --ride-packs');
  }
  return {
    mode,
    store: required('store'),
    out: required('out'),
    date: parseDate(required('date')),
    slots: slots === undefined ? benchSlots : slots.split(',').map(parseSlot),
    ratios: ratios === undefined ? benchBudgetRatios : ratios.split(',').map(parseRatio),
    pairs: pairs === undefined ? null : new RegExp(pairs),
    refetchLimitMs: limit === undefined ? null : parseLimit(limit),
    urlLog: raw.get('url-log') ?? null,
    label: raw.get('label') ?? 'replay',
    exactPacks: raw.get('exact-packs') ?? null,
    exactDelayMs:
      exactDelayMs === undefined ? syntheticMatrixDelayMs : parseDelay(exactDelayMs, 'exact'),
    ridePacks: raw.get('ride-packs') ?? null,
    rideVerify: rideVerify === '1',
    arrivalWave: noArrivalWave !== '1',
    rideDelayMs:
      rideDelayMs === undefined ? syntheticRouteDelayMs : parseDelay(rideDelayMs, 'ride'),
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

function parseDelay(s: string, flag: 'exact' | 'ride'): number {
  if (!/^\d+$/.test(s)) throw new Error(`bad --${flag}-delay-ms: ${s}`);
  return Number(s);
}
