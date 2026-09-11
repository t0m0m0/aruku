// エンジン（packages/engine/src）をビルド成果物ではなくソースのまま解決する配線の検証。
// tsconfig.json の `paths` と vite.config.ts の alias は別々に書くので、片方だけ
// 直すと tsc が通ったままバンドルだけ壊れる。ここはその食い違いを実行時に落とす。

import { describe, expect, it } from 'vitest';

import { kDebugMode, kReleaseMode } from '@aruku/engine/build-mode';
import { seconds } from '@aruku/engine/time';
import { transitRequestTimeout } from '@aruku/engine/services/route-service';

describe('エンジンの解決', () => {
  it('エンジンのソースが @aruku/engine/* で解決できる', () => {
    expect(transitRequestTimeout).toBe(seconds(35));
  });

  it('エンジンのビルド時定数がこのアプリのビルド設定から供給される', () => {
    // build-mode.ts は import.meta.env を読む。alias でソースを引くだけでは足りず、
    // このアプリの Vite 設定が env を注入できていて初めて debug 既定になる。
    expect(kDebugMode).toBe(true);
    expect(kReleaseMode).toBe(false);
  });
});
