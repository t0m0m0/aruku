export function cascade<T>(value: T, apply: (value: T) => void): T {
  apply(value);
  return value;
}
