import type { HttpClient, HttpResponse } from '../../src/services/http-client';

export function jsonResponse(body: unknown, statusCode = 200): HttpResponse {
  return {
    statusCode,
    bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

export function mockClient(
  handler: (url: URL) => HttpResponse | Promise<HttpResponse>,
): HttpClient {
  return {
    get: async (url) => {
      await Promise.resolve();
      return handler(url);
    },
    close: () => {},
  };
}
