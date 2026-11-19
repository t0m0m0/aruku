import { ClientException } from '@aruku/engine/services/http-client';

import {
  BaseHttpClient,
  type HttpHeaders,
  type RequestOptions,
  type StreamedResponse,
} from './http';

export type AppCheckTokenProvider = () => Promise<string | null>;

export interface AppCheckHttpClientOptions {
  readonly tokenProvider: AppCheckTokenProvider;
  readonly limitedUseTokenProvider: AppCheckTokenProvider;
}

const headerName = 'X-Firebase-AppCheck';

const replayProtectedFunctions = new Set(['placesProxy', 'googleWalkMatrixProxy', 'exactWalkMax']);

export class AppCheckHttpClient extends BaseHttpClient {
  constructor(
    private readonly inner: BaseHttpClient,
    private readonly options: AppCheckHttpClientOptions,
  ) {
    super();
  }

  private readonly aborter = new AbortController();

  static requiresLimitedUseToken(url: URL): boolean {
    const segments = url.pathname.split('/').filter((s) => s !== '');
    const last = segments.at(-1);
    return last !== undefined && replayProtectedFunctions.has(last);
  }

  async send(
    url: URL,
    headers: HttpHeaders,
    options: RequestOptions = {},
  ): Promise<StreamedResponse> {
    const needsLimitedUse = AppCheckHttpClient.requiresLimitedUseToken(url);
    let token = await this.tokenOrClosed(
      needsLimitedUse ? this.options.limitedUseTokenProvider : this.options.tokenProvider,
      url,
      options.signal,
    );

    if (token === null && needsLimitedUse) {
      token = await this.tokenOrClosed(this.options.tokenProvider, url, options.signal);
    }

    return this.inner.send(
      url,
      token === null ? headers : { ...headers, [headerName]: token },
      options,
    );
  }

  close(): void {
    this.aborter.abort();
    this.inner.close();
  }

  private async tokenOrClosed(
    provider: AppCheckTokenProvider,
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    if (this.aborter.signal.aborted) {
      throw new ClientException(`Client is already closed: ${url.href}`);
    }
    if (signal?.aborted === true) {
      throw new ClientException(`Request was aborted: ${url.href}`);
    }

    const signals = signal === undefined ? [this.aborter.signal] : [this.aborter.signal, signal];
    let rejectClosed: (error: ClientException) => void = noop;
    const closed = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject;
    });
    const onAbort = (): void => {
      rejectClosed(
        new ClientException(`Request was aborted while acquiring an App Check token: ${url.href}`),
      );
    };
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });

    try {
      return await Promise.race([tokenFrom(provider), closed]);
    } finally {
      for (const s of signals) s.removeEventListener('abort', onAbort);
    }
  }
}

async function tokenFrom(provider: AppCheckTokenProvider): Promise<string | null> {
  try {
    const token = await provider();
    return token === null || token === '' ? null : token;
  } catch {
    return null;
  }
}

function noop(): void {}
