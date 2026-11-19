import { describe, expect, it } from 'vitest';

import { ClientException, TimeoutException } from '@aruku/engine/services/http-client';

import { AppCheckHttpClient } from '../../src/http/app-check-http-client';
import {
  BaseHttpClient,
  type HttpHeaders,
  type RequestOptions,
  type StreamedResponse,
} from '../../src/http/http';
import { TimeoutHttpClient } from '../../src/http/timeout-http-client';

const headerName = 'X-Firebase-AppCheck';

class FakeInnerClient extends BaseHttpClient {
  lastHeaders: HttpHeaders | null = null;
  lastSignal: AbortSignal | undefined = undefined;
  closed = false;

  async send(
    _url: URL,
    headers: HttpHeaders,
    options: RequestOptions = {},
  ): Promise<StreamedResponse> {
    this.lastHeaders = headers;
    this.lastSignal = options.signal;
    return {
      statusCode: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('ok'));
          controller.close();
        },
      }),
    };
  }

  close(): void {
    this.closed = true;
  }
}

const url = (path = 'googleWalkProxy'): URL => new URL(`https://proxy.example.com/${path}`);

describe('AppCheckHttpClient.send', () => {
  it('トークン取得成功時に X-Firebase-AppCheck ヘッダが付与される', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => 'token_abc',
      limitedUseTokenProvider: async () => 'unused',
    });

    await client.send(url(), {});

    expect(inner.lastHeaders?.[headerName]).toBe('token_abc');
  });

  it('トークン取得が例外を投げてもヘッダ未付与でリクエストは継続する', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => {
        throw new Error('App Check 未設定');
      },
      limitedUseTokenProvider: async () => 'unused',
    });

    const response = await client.send(url(), {});

    expect(inner.lastHeaders).not.toBeNull();
    expect(inner.lastHeaders).not.toHaveProperty(headerName);
    expect(response.statusCode).toBe(200);
  });

  it('トークンが null の場合はヘッダを付与しない', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => null,
      limitedUseTokenProvider: async () => 'unused',
    });

    await client.send(url(), {});

    expect(inner.lastHeaders).not.toHaveProperty(headerName);
  });

  it('トークンが空文字列の場合はヘッダを付与しない', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => '',
      limitedUseTokenProvider: async () => 'unused',
    });

    await client.send(url(), {});

    expect(inner.lastHeaders).not.toHaveProperty(headerName);
  });

  it('呼び出し側が渡したヘッダを落とさない', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => 'token_abc',
      limitedUseTokenProvider: async () => 'unused',
    });

    await client.send(url(), { Accept: 'application/json' });

    expect(inner.lastHeaders?.['Accept']).toBe('application/json');
  });
});

describe('limited-use トークン（リプレイ保護, issue #155・#366）', () => {
  const build = (inner: FakeInnerClient): AppCheckHttpClient =>
    new AppCheckHttpClient(inner, {
      tokenProvider: async () => 'standard_token',
      limitedUseTokenProvider: async () => 'limited_use_token',
    });

  for (const path of ['placesProxy', 'googleWalkMatrixProxy', 'exactWalkMax']) {
    it(`${path} へは limited-use プロバイダのトークンを付与する`, async () => {
      const inner = new FakeInnerClient();
      await build(inner).send(url(path), {});
      expect(inner.lastHeaders?.[headerName]).toBe('limited_use_token');
    });
  }

  it('googleWalkProxy へは標準プロバイダのトークンを付与する', async () => {
    const inner = new FakeInnerClient();
    await build(inner).send(url('googleWalkProxy'), {});
    expect(inner.lastHeaders?.[headerName]).toBe('standard_token');
  });

  it('requiresLimitedUseToken は consume 対象のみ true', () => {
    expect(AppCheckHttpClient.requiresLimitedUseToken(url('placesProxy'))).toBe(true);
    expect(AppCheckHttpClient.requiresLimitedUseToken(url('googleWalkMatrixProxy'))).toBe(true);
    expect(AppCheckHttpClient.requiresLimitedUseToken(url('googleWalkProxy'))).toBe(false);
  });
});

describe('使い捨てトークン取得の失敗時は標準トークンへ縮退する（#366）', () => {
  it('limited-use が例外を投げたら標準トークンを付与する', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => 'standard_token',
      limitedUseTokenProvider: async () => {
        throw new Error('quota exceeded');
      },
    });

    await client.send(url('placesProxy'), {});

    expect(inner.lastHeaders?.[headerName]).toBe('standard_token');
  });

  it('limited-use が null / 空文字列でも標準トークンへ縮退する', async () => {
    for (const empty of [null, '']) {
      const inner = new FakeInnerClient();
      const client = new AppCheckHttpClient(inner, {
        tokenProvider: async () => 'standard_token',
        limitedUseTokenProvider: async () => empty,
      });

      await client.send(url('googleWalkMatrixProxy'), {});

      expect(inner.lastHeaders?.[headerName]).toBe('standard_token');
    }
  });

  it('両方失敗したらヘッダ未付与でリクエストは継続する', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => {
        throw new Error('未設定');
      },
      limitedUseTokenProvider: async () => {
        throw new Error('quota exceeded');
      },
    });

    const response = await client.send(url('placesProxy'), {});

    expect(inner.lastHeaders).not.toHaveProperty(headerName);
    expect(response.statusCode).toBe(200);
  });

  it('非対象エンドポイントで標準が失敗しても limited-use は呼ばない', async () => {
    let limitedUseCalls = 0;
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => {
        throw new Error('未設定');
      },
      limitedUseTokenProvider: async () => {
        limitedUseCalls++;
        return 'limited_use_token';
      },
    });

    await client.send(url('googleWalkProxy'), {});

    expect(limitedUseCalls).toBe(0);
    expect(inner.lastHeaders).not.toHaveProperty(headerName);
  });
});

describe('AppCheckHttpClient.close によるトークン待ちの打ち切り (#259)', () => {
  const hangingProviders = {
    tokenProvider: () => new Promise<string>(() => {}),
    limitedUseTokenProvider: () => new Promise<string>(() => {}),
  };

  it('トークン待ちの最中に close すると ClientException で倒れる', async () => {
    const client = new AppCheckHttpClient(new FakeInnerClient(), hangingProviders);

    const pending = client.send(url(), {});
    client.close();

    await expect(pending).rejects.toThrow(ClientException);
  });

  it('close 後の send はトークンを待たずに倒れる', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, hangingProviders);

    client.close();

    await expect(client.send(url(), {})).rejects.toThrow(ClientException);
    expect(inner.lastHeaders).toBeNull();
  });
});

describe('要求単位の中止によるトークン待ちの打ち切り (#488)', () => {
  it('トークン待ちの最中に要求の signal を倒すと、送信せずに倒れる', async () => {
    const inner = new FakeInnerClient();
    let resolveToken: (token: string) => void = () => {};
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: () => new Promise<string>((r) => (resolveToken = r)),
      limitedUseTokenProvider: () => new Promise<string>((r) => (resolveToken = r)),
    });
    const aborter = new AbortController();

    const pending = client.send(url(), {}, { signal: aborter.signal });
    aborter.abort();
    resolveToken('late');

    await expect(pending).rejects.toThrow(ClientException);
    expect(inner.lastHeaders).toBeNull();
  });

  it('中止済みの signal ではトークンを取りに行かない', async () => {
    let calls = 0;
    const client = new AppCheckHttpClient(new FakeInnerClient(), {
      tokenProvider: async () => {
        calls++;
        return 't';
      },
      limitedUseTokenProvider: async () => {
        calls++;
        return 't';
      },
    });
    const aborter = new AbortController();
    aborter.abort();

    await expect(client.send(url(), {}, { signal: aborter.signal })).rejects.toThrow(
      ClientException,
    );
    expect(calls).toBe(0);
  });

  it('要求の signal を内側へ渡す', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => 't',
      limitedUseTokenProvider: async () => 't',
    });
    const aborter = new AbortController();

    await client.send(url(), {}, { signal: aborter.signal });

    expect(inner.lastSignal).toBe(aborter.signal);
  });

  it('要求の中止で client 全体は閉じない', async () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: () => new Promise<string>(() => {}),
      limitedUseTokenProvider: () => new Promise<string>(() => {}),
    });
    const aborter = new AbortController();

    const pending = client.send(url(), {}, { signal: aborter.signal });
    aborter.abort();
    await pending.catch(() => {});

    expect(inner.closed).toBe(false);
  });
});

describe('AppCheckHttpClient.close', () => {
  it('close() が内部クライアントへ委譲される', () => {
    const inner = new FakeInnerClient();
    const client = new AppCheckHttpClient(inner, {
      tokenProvider: async () => null,
      limitedUseTokenProvider: async () => null,
    });

    client.close();

    expect(inner.closed).toBe(true);
  });
});

const hangs = (): Promise<string> => new Promise((resolve) => setTimeout(() => resolve('t'), 200));

describe('TimeoutHttpClient との合成', () => {
  it('内側の App Check トークン取得がハングしても打ち切る (#156)', async () => {
    const client = new TimeoutHttpClient(
      new AppCheckHttpClient(new FakeInnerClient(), {
        tokenProvider: hangs,
        limitedUseTokenProvider: hangs,
      }),
      { timeout: 20 },
    );

    await expect(client.get(url())).rejects.toThrow(TimeoutException);
  });
});
