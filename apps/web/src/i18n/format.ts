// 移植元: flutter-final:lib/core/constants/app_constants.dart の todayDateLabel。
// 同じ所に在った todayGreeting はホームの小見出しごと #432 で撤去した。 doc-consistency:keep 撤去の経緯
//
// 移植元は定数クラスに置いていたが、中身は文言の組み立てなので i18n の側へ寄せた。

import { ja } from './ja';

/// 時刻欄が示す日付。今日・明日は「今日 · M月D日 (曜)」、それより先は日付だけ。
///
/// 年は出さない。選べるのは最大 90 日先までで、年が変わっても月日で取り違えない。
export function pickerDateLabel(date: Date, dateOffset: number): string {
  const lead =
    dateOffset === 0 ? ja.dateToday : dateOffset === 1 ? ja.dateTomorrow : null;
  return lead === null ? todayDateLabel(date) : `${lead} · ${todayDateLabel(date)}`;
}

/// 「M月D日 (曜)」。
///
/// 曜日は Date.getDay()（日曜 = 0）だが、移植元の配列は月曜始まり。移植元は
/// DateTime.weekday（月曜 = 1）で引いていたので、添字の起点が違う。
export function todayDateLabel(now: Date): string {
  const weekday = ja.weekdays[(now.getDay() + 6) % 7];
  return `${now.getMonth() + 1}月${now.getDate()}日 (${weekday})`;
}

const jstOffsetMs = 9 * 3600 * 1000;

/// 時刻表の取得日時（#461）。「YYYY年M月D日 H:MM」を JST で。
///
/// 端末の時差で読まない。取得は ODPT 側の出来事で、利用者が海外にいても日本の時刻で
/// 言うほうが時刻表の改正日と突き合わせられる。
export function fetchedAtLabel(at: Date): string {
  const jst = new Date(at.getTime() + jstOffsetMs);
  const minute = String(jst.getUTCMinutes()).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ` +
    `${jst.getUTCHours()}:${minute}`
  );
}
