// 移植元: lib/core/services/route_service.dart の `http.Client()`（package:http）が
// 担っていた面のうち、エンジンの `HttpClient` 契約が要求する範囲。
//
// 1:1 の移植ではない。Dart 側は package:http の実装をそのまま使っており、独自の
// テストを持たない。ここで検証するのは「fetch をエンジンの契約へ嵌めたときに
// 保たれていなければならないこと」で、とりわけ close() の意味論（#259）。

import { describe, expect, it, vi } from 'vitest';

import { ClientException } from '@aruku/engine/services/http-client';

import {
  FetchHttpClient,
  type Fetch,
} from '../../src/http/fetch-http-client';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('FetchHttpClient.get', () => {
  it('ステータスとボディをエンジンの HttpResponse へ渡す', async () => {
    const client = new FetchHttpClient({
      fetch: async () => new Response(streamOf('{"ok":true}'), { status: 200 }),
    });

    const res = await client.get(new URL('https://example.test/a'));

    expect(res.statusCode).toBe(200);
    expect(text(res.bodyBytes)).toBe('{"ok":true}');
  });

  it('分割して届くボディを連結する', async () => {
    const client = new FetchHttpClient({
      fetch: async () => new Response(streamOf('{"a":', '1}'), { status: 200 }),
    });

    const res = await client.get(new URL('https://example.test/a'));

    expect(text(res.bodyBytes)).toBe('{"a":1}');
  });

  it('200 以外もそのまま返す（ドメイン例外への変換は上位の役目）', async () => {
    const client = new FetchHttpClient({
      fetch: async () => new Response(streamOf('nope'), { status: 401 }),
    });

    const res = await client.get(new URL('https://example.test/a'));

    expect(res.statusCode).toBe(401);
  });

  it('ボディを持たないレスポンスは空の bodyBytes になる', async () => {
    const client = new FetchHttpClient({
      fetch: async () => new Response(null, { status: 204 }),
    });

    const res = await client.get(new URL('https://example.test/a'));

    expect(res.bodyBytes).toHaveLength(0);
  });

  it('通信失敗は ClientException になる', async () => {
    const client = new FetchHttpClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await expect(client.get(new URL('https://example.test/a'))).rejects.toThrow(
      ClientException,
    );
  });

  it('ボディ受信中の失敗も ClientException になる', async () => {
    const client = new FetchHttpClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('network error'));
            },
          }),
          { status: 200 },
        ),
    });

    await expect(client.get(new URL('https://example.test/a'))).rejects.toThrow(
      ClientException,
    );
  });

  it('渡したヘッダを fetch へ引き渡す', async () => {
    const fetch = vi.fn<Fetch>(
      async () => new Response(streamOf('{}'), { status: 200 }),
    );
    const client = new FetchHttpClient({ fetch });

    await client.send(new URL('https://example.test/a'), { 'X-Test': 'v' });

    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('X-Test')).toBe('v');
  });
});

describe('FetchHttpClient.close', () => {
  it('in-flight のリクエストを中断する (#259)', async () => {
    const client = new FetchHttpClient({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            // fetch は中断で AbortError を投げる。ここはその再現。
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });

    const pending = client.get(new URL('https://example.test/a'));
    client.close();

    // キャンセルは SearchScopedRouteService が CancellationToken 側で表現する。
    // クライアントは素の通信エラーを返す契約（transit-api-client.ts:315）。
    await expect(pending).rejects.toThrow(ClientException);
  });

  it('close() 後の get() は ClientException になる', async () => {
    const client = new FetchHttpClient({
      fetch: async () => new Response(streamOf('{}'), { status: 200 }),
    });

    client.close();

    await expect(client.get(new URL('https://example.test/a'))).rejects.toThrow(
      ClientException,
    );
  });

  it('二重の close() は例外にならない', () => {
    const client = new FetchHttpClient({
      fetch: async () => new Response(streamOf('{}'), { status: 200 }),
    });

    client.close();

    expect(() => client.close()).not.toThrow();
  });
});
