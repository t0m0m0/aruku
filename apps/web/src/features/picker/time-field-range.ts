// 移植元: lib/features/picker/time_field_input.dart と
// lib/features/picker/desktop_time_field.dart の値域の算出。
//
// 入力文字列の解釈（移植元 `parseTimeInput`）は運んでいない。`<input type="time">`
// は打ちかけを空文字で返し、確定した値は必ず `HH:MM` なので、任意の文字列から
// 時と分を切り出す規則そのものが要らなくなった。
//
// 残したのは、ブラウザが持っていない側——「いつまで選べるか」「日をまたぐ刻み」
// ——だけ。値域の**保証**はここではなく applyPickedTime が持つ。

import {
  PickerMode,
  TimeValue,
  kMaxDateOffsetDays,
} from '@aruku/engine/models/time-value';

import { kMinBudgetMinutes } from '../../state/app-state';

/// 時刻を1回動かす刻み（分）。
export const kTimeStepMinutes = 5;

const minutesPerDay = 24 * 60;

/// [totalMinutes] を [step] 分動かした結果と、その際にまたいだ日数。
///
/// 日またぎを呼び出し側へ返すのは、時刻だけ折り返して日付を据え置くと 23:58 の
/// 5分後が「同日の 00:03」になるため。到着が翌日のままなら1時間の予算が25時間
/// 近くへ膨らむ。時刻と日付は必ず一緒に動かす。
export function stepTotalMinutes(
  totalMinutes: number,
  step: number,
): { totalMinutes: number; dayDelta: number } {
  const moved = totalMinutes + step;
  const dayDelta = Math.floor(moved / minutesPerDay);
  return { totalMinutes: moved - dayDelta * minutesPerDay, dayDelta };
}

/// 出発の下限。今日を指しているなら現在時刻より前へは置かない。
///
/// `min` 属性は案内であって保証ではない——キー入力もオートフィルも範囲外を渡せる。
/// 14:00 に 09:00 と打てると、出発も（連動する）到着も過去のまま経路照会へ行き、
/// 結果が黙って意味を失う。
export function clampDepartureMinutes(args: {
  totalMinutes: number;
  dateOffset: number;
  nowMinutes: number;
}): number {
  return args.dateOffset === 0 && args.totalMinutes < args.nowMinutes
    ? args.nowMinutes
    : args.totalMinutes;
}

/// カレンダーが出す最初の日。
///
/// 出発より前を選ばせると applyPickedTime が戻すので、選んだ日と確定した日が
/// 食い違う。「今すぐ」でも実時刻ではなく保持値で数える——欄が出しているのは
/// 保持値であり、下限だけ実時刻へ寄せると選べる日と表示が食い違う（実時刻への
/// 追従は確定時の rebaseDates が引き受ける）。
export function firstSelectableOffset(
  mode: PickerMode,
  departure: TimeValue,
): number {
  if (mode === PickerMode.depart) return 0;
  const offset = departure.isNow ? 0 : departure.dateOffset;
  const carry = Math.floor(
    (departure.totalMinutes + kMinBudgetMinutes) / minutesPerDay,
  );
  return offset + carry;
}

/// カレンダーが出す最後の日。
///
/// 押し出された到着は [kMaxDateOffsetDays] の外に居ることがあり、定数で切ると
/// その日がカレンダーから消えて、開いて確定しただけで値が動く。
export function lastSelectableOffset(
  mode: PickerMode,
  departure: TimeValue,
  current: TimeValue,
): number {
  return Math.max(
    kMaxDateOffsetDays,
    firstSelectableOffset(mode, departure),
    current.dateOffset,
  );
}
