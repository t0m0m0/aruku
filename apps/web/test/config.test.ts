import { afterEach, describe, expect, it, vi } from 'vitest';

// appConfig はモジュールの評価時に import.meta.env を読むので、値ごとに読み直す。
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
