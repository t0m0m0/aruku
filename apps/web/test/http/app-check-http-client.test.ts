// 移植元: test/core/services/app_check_http_client_test.dart（#155・#366）
//
// 加えて timeout_http_client_test.dart の
// '内側の App Check トークン取得がハングしても打ち切る (#156)' をここへ置いている
// （合成順の検証で、この層が在って初めて書ける）。
//
// 移植元との差: tokenProvider / limitedUseTokenProvider は省略可能ではなく必須に
// した。Dart は FirebaseAppCheck.instance から静的に取れたが、Firebase JS SDK の
// getToken は initializeAppCheck が返すインスタンスを要る。既定値を持てないので、
// Firebase の取得は合成のルート（src/search/ の配線）へ出した。
// これに伴い 'トークンが null …' / '… 空文字列 …' の2本は、移植元が
// limitedUseTokenProvider を注入しつつ実際には既定の標準プロバイダの例外を見ていた
// のを、標準プロバイダへ直接 null / '' を注入する形に改めている。

import { describe, expect, it } from 'vitest';

import { TimeoutException } from '@aruku/engine/services/http-client';

import { AppCheckHttpClient } from '../../src/http/app-check-http-client';
import { BaseHttpClient, type HttpHeaders, type StreamedResponse } from '../../src/http/http';
import { TimeoutHttpClient } from '../../src/http/timeout-http-client';

const headerName = 'X-Firebase-AppCheck';

/// send されたヘッダと close 呼び出しを記録する内側クライアント。
class FakeInnerClient extends BaseHttpClient {
  lastHeaders: HttpHeaders | null = null;
  closed = false;

  async send(_url: URL, headers: HttpHeaders): Promise<StreamedResponse> {
    this.lastHeaders = headers;
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

// 既定は consume 対象外のパス。ヘッダ付与そのものを見るテストが
// tokenProvider（標準トークン側）の注入を確実に通るようにする。
const url = (path = 'googleWalkProxy'): URL =>
  new URL(`https://proxy.example.com/${path}`);

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

  // サーバが consume:true で検証するエンドポイントとここは厳密一致させる。
  // 送りすぎ（対象外へ使い捨て）はアテステーション・クォータを無駄に焼き、
  // 送り足りない（対象へ標準）は 2 回目以降 401 で機能を壊す。
  for (const path of ['placesProxy', 'googleWalkMatrixProxy']) {
    it(`${path} へは limited-use プロバイダのトークンを付与する`, async () => {
      const inner = new FakeInnerClient();
      await build(inner).send(url(path), {});
      expect(inner.lastHeaders?.[headerName]).toBe('limited_use_token');
    });
  }

  // 1検索で 21 本まで膨らむ（spec §3.8）。ここを使い捨てにするとクォータが先に尽き、
  // getLimitedUseToken の失敗＝ヘッダ落ち＝全要求 401 を招く。
  it('googleWalkProxy へは標準プロバイダのトークンを付与する', async () => {
    const inner = new FakeInnerClient();
    await build(inner).send(url('googleWalkProxy'), {});
    expect(inner.lastHeaders?.[headerName]).toBe('standard_token');
  });

  it('requiresLimitedUseToken は consume 対象のみ true', () => {
    expect(AppCheckHttpClient.requiresLimitedUseToken(url('placesProxy'))).toBe(
      true,
    );
    expect(
      AppCheckHttpClient.requiresLimitedUseToken(url('googleWalkMatrixProxy')),
    ).toBe(true);
    expect(
      AppCheckHttpClient.requiresLimitedUseToken(url('googleWalkProxy')),
    ).toBe(false);
  });
});

describe('使い捨てトークン取得の失敗時は標準トークンへ縮退する（#366）', () => {
  // アテステーション・クォータが枯渇すると getLimitedUseToken() は throw する。
  // ここで諦めてヘッダ無しにすると、サーバ側で consume を切っても「トークン欠落」で
  // 401 のままになり、緊急ロールバックが効かない。標準トークンへ落とせば
  // APP_CHECK_CONSUME_ENDPOINTS="" と組み合わせて完全復旧できる。
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

  // 縮退は使い捨てが要る経路だけ。非対象で標準が失敗しても縮退先は無い。
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

const hangs = (): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve('t'), 200));

describe('TimeoutHttpClient との合成', () => {
  it('内側の App Check トークン取得がハングしても打ち切る (#156)', async () => {
    // 合成順を TimeoutHttpClient(AppCheckHttpClient(...)) と最外側にすることで、
    // トークン取得の待ちも header タイムアウトの内側に収まる。
    const client = new TimeoutHttpClient(
      new AppCheckHttpClient(new FakeInnerClient(), {
        // どちらのプロバイダを経由しても打ち切られること。片方だけ遅くすると、
        // エンドポイントの分類（consume 対象か）を変える退行でこのテストが
        // 巻き添えで赤くなり、何を守っているのかが読めなくなる。
        tokenProvider: hangs,
        limitedUseTokenProvider: hangs,
      }),
      { timeout: 20 },
    );

    await expect(client.get(url())).rejects.toThrow(TimeoutException);
  });
});
