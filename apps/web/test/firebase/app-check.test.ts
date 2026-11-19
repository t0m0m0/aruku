import { describe, expect, it } from 'vitest';

import { canActivateAppCheck } from '../../src/firebase/app-check';

describe('有効化の可否', () => {
  it('サイトキーがあれば有効化できる', () => {
    expect(
      canActivateAppCheck({
        usesDebugProvider: false,
        recaptchaSiteKey: 'site-key',
      }),
    ).toBe(true);
  });

  it('本番でサイトキーが無ければ有効化しない', () => {
    expect(canActivateAppCheck({ usesDebugProvider: false, recaptchaSiteKey: '' })).toBe(false);
  });

  it('空白だけのサイトキーは無いものとして扱う', () => {
    expect(canActivateAppCheck({ usesDebugProvider: false, recaptchaSiteKey: '   ' })).toBe(false);
  });

  it('デバッグならサイトキーが無くても有効化できる', () => {
    expect(canActivateAppCheck({ usesDebugProvider: true, recaptchaSiteKey: '' })).toBe(true);
  });
});
