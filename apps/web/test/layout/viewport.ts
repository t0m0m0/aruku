import { act } from '@testing-library/react';
import { vi } from 'vitest';

import { desktopMediaQuery } from '../../src/layout/breakpoints';

export interface StubbedViewport {
  cross(desktop: boolean): void;

  listenerCount(): number;
}

export function stubViewport(desktop: boolean): StubbedViewport {
  const listeners = new Set<() => void>();
  const mql = {
    matches: desktop,
    media: desktopMediaQuery,
    addEventListener: (_type: 'change', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: () => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      if (query !== desktopMediaQuery) {
        throw new Error(`想定外のメディアクエリ: ${query}`);
      }
      return mql;
    }),
  );
  return {
    cross(next: boolean) {
      mql.matches = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    listenerCount: () => listeners.size,
  };
}
