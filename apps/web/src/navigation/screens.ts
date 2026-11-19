export const Screen = {
  home: 'home',
  search: 'search',
  searchOrigin: 'searchOrigin',
  loading: 'loading',
  result: 'result',
  error: 'error',
} as const;
export type Screen = (typeof Screen)[keyof typeof Screen];

export const screenPath: Readonly<Record<Screen, string>> = {
  [Screen.home]: '/home',
  [Screen.search]: '/home/search',
  [Screen.searchOrigin]: '/home/search-origin',
  [Screen.loading]: '/home/loading',
  [Screen.result]: '/home/result',
  [Screen.error]: '/home/error',
};

export const fallbackScreen: Screen = Screen.home;

const screenByPath = new Map<string, Screen>(
  Object.values(Screen).map((screen) => [screenPath[screen], screen]),
);

export function screenFromLocation(location: string): Screen {
  const path = new URL(location, 'https://placeholder.invalid').pathname;
  return screenByPath.get(path) ?? fallbackScreen;
}
