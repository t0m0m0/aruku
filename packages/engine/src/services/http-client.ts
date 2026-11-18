export interface HttpResponse {
  readonly statusCode: number;
  readonly bodyBytes: Uint8Array;
}

export interface HttpClient {
  get(url: URL): Promise<HttpResponse>;
  close(): void;
}

export class ClientException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientException';
  }
}

export class TimeoutException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutException';
  }
}
