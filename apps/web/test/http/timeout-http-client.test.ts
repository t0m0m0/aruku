// 移植元: test/core/services/timeout_http_client_test.dart（#156）
//
// 移植元の '内側の App Check トークン取得がハングしても打ち切る (#156)' だけは
// app-check-http-client.test.ts へ置いた。合成順（TimeoutHttpClient を最外側に
// 置く）の検証であり、App Check 側が在って初めて書けるため。

import { describe, expect, it } from 'vitest';

import {
  TimeoutException,
  type HttpResponse,
} from '@aruku/engine/services/http-client';
import { seconds, type Duration } from '@aruku/engine/time';

import { BaseHttpClient, type HttpHeaders, type StreamedResponse } from '../../src/http/http';
import { TimeoutHttpClient } from '../../src/http/timeout-http-client';

function delay(duration: Duration): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/// 応答までの遅延と close 呼び出しを制御できる内側クライアント。
class FakeInnerClient extends BaseHttpClient {
  constructor(private readonly responseDelay: Duration = 0) {
    super();
  }

  closed = false;

  async send(_url: URL, _headers: HttpHeaders): Promise<StreamedResponse> {
    if (this.responseDelay > 0) await delay(this.responseDelay);
    return { statusCode: 200, body: bodyOf('ok') };
  }

  close(): void {
    this.closed = true;
  }
}

/// ヘッダは即返すが、ボディの1 chunk 目が [bodyDelay] 後にしか流れない内側
/// クライアント。ヘッダ受信後のボディ送出ストールを再現する。
class StallingBodyClient extends BaseHttpClient {
  constructor(private readonly bodyDelay: Duration) {
    super();
  }

  async send(_url: URL, _headers: HttpHeaders): Promise<StreamedResponse> {
    const bodyDelay = this.bodyDelay;
    return {
      statusCode: 200,
      body: new ReadableStream({
        async pull(controller) {
          await delay(bodyDelay);
          controller.enqueue(new TextEncoder().encode('ok'));
          controller.close();
        },
      }),
    };
  }

  close(): void {}
}

const url = new URL('https://example.com/x');

describe('TimeoutHttpClient.send', () => {
  it('内側が制限時間内に応答すればそのまま透過する', async () => {
    const client = new TimeoutHttpClient(new FakeInnerClient(), {
      timeout: seconds(5),
    });

    const response: HttpResponse = await client.get(url);

    expect(response.statusCode).toBe(200);
  });

  it('内側が制限時間を超えると TimeoutException を投げる', async () => {
    const client = new TimeoutHttpClient(new FakeInnerClient(200), {
      timeout: 20,
    });

    await expect(client.get(url)).rejects.toThrow(TimeoutException);
  });

  it('既定のタイムアウトは 15 秒', () => {
    expect(new TimeoutHttpClient(new FakeInnerClient()).timeout).toBe(
      seconds(15),
    );
  });

  it('ヘッダ受信後のボディ送出ストールも TimeoutException で打ち切る (#156)', async () => {
    // ヘッダは即返るので send の header タイムアウトでは拾えない。get() が
    // ボディを読み切る際に chunk 間アイドルで打ち切られること。
    const client = new TimeoutHttpClient(new StallingBodyClient(200), {
      timeout: 20,
    });

    await expect(client.get(url)).rejects.toThrow(TimeoutException);
  });
});

describe('TimeoutHttpClient.close', () => {
  it('close() が内側クライアントへ委譲される', () => {
    const inner = new FakeInnerClient();
    const client = new TimeoutHttpClient(inner);

    client.close();

    expect(inner.closed).toBe(true);
  });
});
