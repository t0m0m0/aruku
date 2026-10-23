/// 端末のタイムゾーンを一時的に [timeZone] へ切り替えて [body] を走らせる。
///
/// vitest は TZ を Asia/Tokyo に固定している（vitest.config.ts）ので、naive な JST の
/// `Date`（§4 #121）と実際の時刻とが一致してしまい、取り違えが素通りする。境界で時差を
/// 正しく扱っているかは、JST 以外の端末を作らないと確かめられない。
export async function inTimeZone<T>(
  timeZone: string,
  body: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return await body();
  } finally {
    process.env.TZ = previous;
  }
}
