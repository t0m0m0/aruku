import type { HttpClient, HttpResponse } from '@aruku/engine/services/http-client';

export type HttpHeaders = Readonly<Record<string, string>>;

export interface StreamedResponse {
  readonly statusCode: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface AbortableHttpClient extends HttpClient {
  get(url: URL, options?: RequestOptions): Promise<HttpResponse>;
}

export abstract class BaseHttpClient implements AbortableHttpClient {
  abstract send(
    url: URL,
    headers: HttpHeaders,
    options?: RequestOptions,
  ): Promise<StreamedResponse>;

  abstract close(): void;

  async get(url: URL, options: RequestOptions = {}): Promise<HttpResponse> {
    const response = await this.send(url, {}, options);
    return {
      statusCode: response.statusCode,
      bodyBytes: await readAllBytes(response.body),
    };
  }
}

async function readAllBytes(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
