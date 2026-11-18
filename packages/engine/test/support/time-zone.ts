export async function inTimeZone<T>(timeZone: string, body: () => T | Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return await body();
  } finally {
    process.env.TZ = previous;
  }
}
