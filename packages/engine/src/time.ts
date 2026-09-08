/// Dart が言語・コアライブラリで与えていた時間の型を TypeScript 側で揃えるための最小の
/// 道具立て（#384）。エンジン本体とテストの両方が使う。

/// Dart の `Duration` に対応する型。単位はミリ秒。
///
/// クラスにしないのは、`Duration.zero` との比較・大小比較・加減算が素の数値なら
/// そのまま書けるため。Dart 側の `Duration(seconds: 3)` は [seconds] で書く。
export type Duration = number;

export const durationZero: Duration = 0;

export const milliseconds = (n: number): Duration => n;
export const seconds = (n: number): Duration => n * 1000;
export const minutes = (n: number): Duration => n * 60 * 1000;

/// Dart の `DateTime(y, mo, d, h, mi, s, ms)`（端末ローカルの壁時計から作る naive な
/// 日時）に対応する。
///
/// `new Date(...)` を直接使わないのは、JavaScript の月が 0 始まりで Dart は 1 始まり
/// だから。移植で最も静かに壊れる箇所——月がひと月ずれても型は通り、テストは「別の日の
/// ダイヤ」を見に行くだけで、失敗理由が時刻ロジックの誤りに見える。呼び出し側から
/// 0/1 始まりの選択肢そのものを消す。
///
/// Dart の非 UTC `DateTime` と JavaScript の `Date` はどちらも「ローカル壁時計の
/// フィールドから作った絶対時刻」で、`difference` / `getTime()` の差はともに実経過時間に
/// なる。つまり #121（端末 TZ 依存で乗車待ちが負になる）と同じ罠がそのまま残っている。
/// 意図的に揃えている——ここで意味論を変えると、移植ミスと設計変更が混ざる。
export function dateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

/// Dart の `DateTime.difference(other).inMinutes`（切り捨て、負もあり得る）に対応する。
export function differenceInMinutes(a: Date, b: Date): number {
  return Math.trunc((a.getTime() - b.getTime()) / 60000);
}
