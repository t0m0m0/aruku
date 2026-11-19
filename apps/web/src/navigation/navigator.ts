import type { Navigate } from '../state/store';
import { Screen, screenFromLocation, screenPath } from './screens';

export interface RouterLike {
  currentPath(): string;
  navigate(path: string, options?: { replace?: boolean }): void;

  back(): void;
}

export interface HistoryLike {
  currentPath(): string;

  currentUrl(): string;

  isRouterEntry(): boolean;

  hasParentEntry(): boolean;

  back(): void;

  replaceState(url: string, index: number): void;
  pushState(url: string, index: number): void;
}

export function navigationIntent(from: Screen, to: Screen): 'push' | 'replace' | 'pop' {
  if (from === to) return 'replace';
  if (from === Screen.home) return 'push';
  return to === Screen.home ? 'pop' : 'replace';
}

export function createNavigator(router: RouterLike): Navigate {
  return (path: string) => {
    const from = screenFromLocation(router.currentPath());
    const to = screenFromLocation(path);
    const intent = navigationIntent(from, to);
    if (intent === 'pop') {
      router.back();
      return;
    }
    router.navigate(path, { replace: intent === 'replace' });
  };
}

export function seedInitialHistory(history: HistoryLike, canSeed: (url: string) => boolean): void {
  const url = history.currentUrl();
  const path = history.currentPath();
  const screen = screenFromLocation(path);
  if (screen === Screen.home || screenPath[screen] !== path) return;

  if (history.isRouterEntry()) {
    if (!canSeed(url) && history.hasParentEntry()) history.back();
    return;
  }

  if (!canSeed(url)) return;
  history.replaceState(screenPath[Screen.home], 0);
  history.pushState(url, 1);
}

export function browserHistory(): HistoryLike {
  return {
    currentPath: () => window.location.pathname,
    currentUrl: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
    isRouterEntry: () => window.history.state !== null,
    hasParentEntry: () => {
      const state: unknown = window.history.state;
      const idx = typeof state === 'object' && state !== null && 'idx' in state ? state.idx : null;
      return typeof idx === 'number' && idx > 0;
    },
    replaceState: (url, index) => window.history.replaceState({ idx: index }, '', url),
    pushState: (url, index) => window.history.pushState({ idx: index }, '', url),
    back: () => window.history.back(),
  };
}
