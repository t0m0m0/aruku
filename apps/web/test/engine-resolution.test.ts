import { describe, expect, it } from 'vitest';

import { kDebugMode, kReleaseMode } from '@aruku/engine/build-mode';
import { seconds } from '@aruku/engine/time';
import { transitRequestTimeout } from '@aruku/engine/services/route-service';

describe('エンジンの解決', () => {
  it('エンジンのソースが @aruku/engine/* で解決できる', () => {
    expect(transitRequestTimeout).toBe(seconds(35));
  });

  it('エンジンのビルド時定数がこのアプリのビルド設定から供給される', () => {
    expect(kDebugMode).toBe(true);
    expect(kReleaseMode).toBe(false);
  });
});
