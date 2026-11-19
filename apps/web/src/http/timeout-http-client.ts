import { TimeoutException } from '@aruku/engine/services/http-client';
import { seconds, type Duration } from '@aruku/engine/time';

import {
  BaseHttpClient,
  type HttpHeaders,
  type RequestOptions,
  type StreamedResponse,
} from './http';

export interface TimeoutHttpClientOptions {
  readonly timeout?: Duration;
}

export class TimeoutHttpClient extends BaseHttpClient {
  constructor(
    private readonly inner: BaseHttpClient,
    options: TimeoutHttpClientOptions = {},
  ) {
    super();
    this.timeout = options.timeout ?? seconds(15);
  }

  readonly timeout: Duration;

  async send(
    url: URL,
    headers: HttpHeaders,
    options: RequestOptions = {},
  ): Promise<StreamedResponse> {
    const response = await withTimeout(
      this.inner.send(url, headers, options),
      this.timeout,
      `header timeout after ${this.timeout}ms: ${url.href}`,
    );
    return {
      statusCode: response.statusCode,
      body: response.body === null ? null : withIdleTimeout(response.body, this.timeout, url),
    };
  }

  close(): void {
    this.inner.close();
  }
}

function withTimeout<T>(promise: Promise<T>, limit: Duration, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutException(message)), limit);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  limit: Duration,
  url: URL,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await withTimeout(
          reader.read(),
          limit,
          `body idle timeout after ${limit}ms: ${url.href}`,
        );
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
