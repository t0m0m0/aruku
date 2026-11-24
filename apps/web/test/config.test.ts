import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return (await import('../src/config')).appConfig;
}

describe('VITE_EXACT_WALK_MAX (#460)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('1 なら厳密走査を有効にする', async () => {
    vi.stubEnv('VITE_EXACT_WALK_MAX', '1');
    expect((await loadConfig()).exactWalkMax).toBe(true);
  });

  it('未設定なら無効', async () => {
    vi.stubEnv('VITE_EXACT_WALK_MAX', undefined);
    expect((await loadConfig()).exactWalkMax).toBe(false);
  });

  it('1 以外の値は無効として扱う', async () => {
    for (const value of ['', '0', 'false', 'true', ' 1']) {
      vi.stubEnv('VITE_EXACT_WALK_MAX', value);
      expect((await loadConfig()).exactWalkMax, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('VITE_RIDE_DEPARTURES (#549)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('1 なら乗車時刻の確定に時刻表パックを使う', async () => {
    vi.stubEnv('VITE_RIDE_DEPARTURES', '1');
    expect((await loadConfig()).rideDepartures).toBe(true);
  });

  it('未設定と 1 以外の値は無効', async () => {
    for (const value of [undefined, '', '0', 'true']) {
      vi.stubEnv('VITE_RIDE_DEPARTURES', value);
      expect((await loadConfig()).rideDepartures, JSON.stringify(value)).toBe(false);
    }
  });
});
