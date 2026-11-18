export function dartDouble(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
