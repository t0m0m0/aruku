// 移植元: lib/core/config/app_check_provider.dart と
// test/core/config/app_check_provider_test.dart。
//
// Firebase に触れる初期化そのものはここで見ない（実 SDK を起動してしまう）。
// 押さえるのは「いつバイパスを許すか」「いつ有効化を見送るか」という security の芯。

import { describe, expect, it } from 'vitest';

import { canActivateAppCheck } from '../../src/firebase/app-check';

// デバッグプロバイダを使うかの判定はここに無い。`import.meta.env.DEV` を直に書いて
// ビルド時に畳ませているためで、注入できる形にすると本番バンドルからバイパスが
// 消えなくなる（app-check.ts の注記）。その保証は dist の中身でしか反証できない。

describe('有効化の可否', () => {
  it('サイトキーがあれば有効化できる', () => {
    expect(
      canActivateAppCheck({
        usesDebugProvider: false,
        recaptchaSiteKey: 'site-key',
      }),
    ).toBe(true);
  });

  // 見送るとプロキシは 401 を返す（＝安全側）。握り潰して素通しにはしない。
  it('本番でサイトキーが無ければ有効化しない', () => {
    expect(
      canActivateAppCheck({ usesDebugProvider: false, recaptchaSiteKey: '' }),
    ).toBe(false);
  });

  it('空白だけのサイトキーは無いものとして扱う', () => {
    expect(
      canActivateAppCheck({ usesDebugProvider: false, recaptchaSiteKey: '   ' }),
    ).toBe(false);
  });

  // デバッグモードでは SDK がプロバイダを一切呼ばずトークンを交換する
  // （getToken / getLimitedUseToken の両方）。サイトキーは要らない。
  it('デバッグならサイトキーが無くても有効化できる', () => {
    expect(
      canActivateAppCheck({ usesDebugProvider: true, recaptchaSiteKey: '' }),
    ).toBe(true);
  });
});
