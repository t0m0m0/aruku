// 移植元: lib/core/navigation/screen_paths.dart

import { describe, expect, it } from 'vitest';

import {
  fallbackScreen,
  Screen,
  screenFromLocation,
  screenPath,
} from '../../src/navigation/screens';

describe('screenPath', () => {
  it('画面ごとに一意のパスを持つ', () => {
    const paths = Object.values(screenPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('home 以外はすべて home の下にぶら下がる（戻り先が home になる）', () => {
    for (const screen of Object.values(Screen)) {
      if (screen === Screen.home) continue;
      expect(screenPath[screen].startsWith('/home/')).toBe(true);
    }
  });
});

describe('screenFromLocation', () => {
  it('登録済みのパスをその画面へ解決する', () => {
    expect(screenFromLocation('/home/result')).toBe(Screen.result);
    expect(screenFromLocation('/home/search-origin')).toBe(Screen.searchOrigin);
  });

  it('クエリが付いていても解決できる', () => {
    expect(screenFromLocation('/home/settings?tab=a')).toBe(Screen.settings);
  });

  it('未知のパスは安全側の home へ解決する', () => {
    // 削除済みのパス（/home/nav・/home/complete）やタイプミスの deep link。
    expect(screenFromLocation('/home/nav')).toBe(fallbackScreen);
    expect(screenFromLocation('/')).toBe(fallbackScreen);
  });
});
