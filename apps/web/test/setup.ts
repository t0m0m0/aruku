import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  // oxlint-disable-next-line typescript/no-deprecated
  addListener: () => {},
  // oxlint-disable-next-line typescript/no-deprecated
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = () => {};
