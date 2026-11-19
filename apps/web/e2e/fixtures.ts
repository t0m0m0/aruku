import { expect, test as base } from '@playwright/test';

import { previewOrigin } from './upstream/endpoints';
import { installFakeUpstream, type UpstreamLog } from './upstream/fake-upstream';
import { places } from './world';

interface Fixtures {
  upstream: UpstreamLog;

  guards: void;
}

export const test = base.extend<Fixtures>({
  upstream: async ({ page }, use) => {
    const log = await installFakeUpstream(page, { places });

    await use(log);

    expect(log.unmatched.map((u) => `${u.pathname}${u.search}`)).toEqual([]);
  },

  guards: [
    async ({ page }, use) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const external: string[] = [];

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (!url.protocol.startsWith('http')) return;
        if (url.origin === previewOrigin) return;
        external.push(request.url());
      });

      await use();

      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);

      expect(external).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
