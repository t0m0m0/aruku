export function dartRound(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

export function dartDouble(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
