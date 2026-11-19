import { ClientException } from '@aruku/engine/services/http-client';

import {
  BaseHttpClient,
  type HttpHeaders,
  type RequestOptions,
  type StreamedResponse,
} from './http';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchHttpClientOptions {
  readonly fetch?: Fetch;
}

export class FetchHttpClient extends BaseHttpClient {
  private readonly fetch: Fetch;
  private readonly aborter = new AbortController();

  constructor(options: FetchHttpClientOptions = {}) {
    super();
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(
    url: URL,
    headers: HttpHeaders,
    options: RequestOptions = {},
  ): Promise<StreamedResponse> {
    if (this.aborter.signal.aborted) {
      throw new ClientException(`Client is already closed: ${url.href}`);
    }
    if (options.signal?.aborted === true) {
      throw new ClientException(`Request was aborted: ${url.href}`);
    }

    const linked = linkSignals(this.aborter.signal, options.signal);
    let response: Response;
    try {
      response = await this.fetch(url.href, { headers, signal: linked.signal });
    } catch (error) {
      linked.release();
      throw asClientException(error);
    }

    if (response.body === null) {
      linked.release();
      return { statusCode: response.status, body: null };
    }
    return {
      statusCode: response.status,
      body: rethrowAsClientException(response.body, linked.release),
    };
  }

  close(): void {
    this.aborter.abort();
  }
}

function asClientException(error: unknown): ClientException {
  if (error instanceof ClientException) return error;
  return new ClientException(error instanceof Error ? error.message : String(error));
}

function rethrowAsClientException(
  stream: ReadableStream<Uint8Array>,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          onSettled();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        onSettled();
        controller.error(asClientException(error));
      }
    },
    cancel: (reason) => {
      onSettled();
      return reader.cancel(reason);
    },
  });
}

function linkSignals(
  client: AbortSignal,
  request: AbortSignal | undefined,
): { signal: AbortSignal; release: () => void } {
  if (request === undefined) return { signal: client, release: () => {} };

  const linked = new AbortController();
  const abort = () => linked.abort();
  client.addEventListener('abort', abort, { once: true });
  request.addEventListener('abort', abort, { once: true });
  return {
    signal: linked.signal,
    release: () => {
      client.removeEventListener('abort', abort);
      request.removeEventListener('abort', abort);
    },
  };
}
