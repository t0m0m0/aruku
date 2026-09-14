// 移植元: lib/features/picker/（date_time_picker_sheet.dart 全体と
// desktop_time_field.dart の欄まわり）。
//
// 移植元はモバイルのホイールシートとデスクトップの自作欄・月グリッドを別々に
// 持っていた。ここでは native の `<input type="time">` / `<input type="date">`
// 1 組に畳んでいる——どちらもブラウザが端末に合わせた UI（スマホならホイール、
// デスクトップならキー入力とカレンダー）を出すので、出し分けそのものが要らない。
//
// 「押しても開かないボタン」を避けるため、値を出すだけだった home の欄はこれに
// 置き換わる（#386 スライス2 の申し送り）。

import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import {
  PickerMode,
  calendarDaysBetween,
  dateOffsetFrom,
} from '@aruku/engine/models/time-value';

import { ja } from '../../i18n/ja';
import type { AppStore, Now } from '../../state/store';
import {
  clampDepartureMinutes,
  firstSelectableOffset,
  kTimeStepMinutes,
  lastSelectableOffset,
  stepTotalMinutes,
} from './time-field-range';
import styles from './time-field.module.css';

interface TimeFieldProps {
  store: StoreApi<AppStore>;
  mode: PickerMode;
  label: string;

  /// 現在時刻の供給元。過去時刻の切り上げと、選べる日付の範囲の基準に使う。
  now?: Now;
}

export function TimeField({ store, mode, label, now = () => new Date() }: TimeFieldProps) {
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const current = mode === PickerMode.depart ? departure : arrival;

  // 状態の dateOffset が数えている「今日」。dateOffset は state に基準日を持たない
  // ので、日が変わると保持値は黙って1日先を指す。ここに基準を留めておき、確定の
  // たびに実時刻との差を数えて詰め直す。
  //
  // 描画のたびに読み直してはいけない。打鍵による再描画で基準だけが新しい日へ進み、
  // 状態の側は古い日のまま取り残される——差が 0 に見えるので詰め直しが走らず、
  // 触っていない側（出発を打っているときの到着）が1日先を指したまま残る。
  const basisRef = useRef(now());
  const basis = basisRef.current;

  const first = firstSelectableOffset(mode, departure);
  const last = lastSelectableOffset(mode, departure, current);

  const [time, setTime] = useSyncedInput(current.format());
  const [date, setDate] = useSyncedInput(isoDate(dateAt(basis, current.dateOffset)));

  /// 欄の値を状態へ確定する。日付は**絶対日付**で受ける——基準日が動いても
  /// 意味が変わらないのは絶対日付だけで、今日からの日数は詰め直しの前後で別の日を指す。
  function commit(h: number, m: number, pickedDate: Date): void {
    const closed = now();
    const elapsed = calendarDaysBetween({ from: basis, to: closed });
    basisRef.current = closed;
    // 跨いだときだけ詰め直す。移植元は跨がなくても（0 でも）通して過ぎた時刻を
    // 引き上げていたが、あれは日付ダイアログを閉じるという「区切り」があっての
    // こと。区切りの無い native の欄で毎回通すと、到着を打つたびに出発が現在時刻へ
    // 飛ぶ。過ぎた時刻の引き上げは下の clampDepartureMinutes が受け持つ。
    if (elapsed !== 0) store.getState().rebaseDates(elapsed, closed);

    const state = store.getState();
    const maxOffset = lastSelectableOffset(
      mode,
      state.departure,
      mode === PickerMode.depart ? state.departure : state.arrival,
    );
    const dateOffset = dateOffsetFrom({ picked: pickedDate, now: closed, maxOffset });

    let total = h * 60 + m;
    // 到着の下限（出発 + 最小ギャップ）は applyPickedTime が持っている。
    // ここで見るのは出発の下限だけ。
    if (mode === PickerMode.depart) {
      total = clampDepartureMinutes({
        totalMinutes: total,
        dateOffset,
        nowMinutes: closed.getHours() * 60 + closed.getMinutes(),
      });
    }
    state.applyPickedTime({
      mode,
      h: Math.floor(total / 60),
      m: total % 60,
      dateOffset,
    });
    // 確定した値を欄へ書き戻す（移植元 `_syncFromState`）。寄せた先が元の値と同じ
    // ときは state が変わらず、描画中の同期が働かない——打った値が欄に残り、
    // 状態と食い違ったまま検索へ行く。
    const settled =
      mode === PickerMode.depart
        ? store.getState().departure
        : store.getState().arrival;
    setTime(settled.format());
    setDate(isoDate(dateAt(closed, settled.dateOffset)));
  }

  /// 欄を離れたときに確定する（移植元 `_commitText`）。
  ///
  /// 打っている途中では確定しない。時・分は1桁ずつ来るので、`23:58` と打つ途中に
  /// `02:58` が現れる——それを確定すると過去時刻の切り上げが割り込み、打った値ごと
  /// 現在時刻へ差し替わる（実ブラウザで確認）。読めない値は「消しただけ」であって
  /// 時刻の指定ではないので、直前の値へ戻す。
  function onTimeBlur(): void {
    const parsed = parseIsoTime(time);
    if (parsed === null) {
      setTime(current.format());
      return;
    }
    commit(parsed.h, parsed.m, dateAt(basis, current.dateOffset));
  }

  function onDateBlur(): void {
    const picked = parseIsoDate(date);
    if (picked === null) {
      setDate(isoDate(dateAt(basis, current.dateOffset)));
      return;
    }
    commit(current.h, current.m, picked);
  }

  /// ↑↓ を横取りして、日をまたぐ刻みでは日付も一緒に動かす。
  ///
  /// native の ↑↓ は同日内で折り返す。23:58 の5分後が「同じ日の 00:03」になると、
  /// 翌日のままの到着との予算が1時間から25時間近くへ膨らむ。
  function onTimeKeyDown(key: string, preventDefault: () => void): void {
    // Enter は「打ち終えた」の合図。欄を離れずに検索へ行けるようにする。
    if (key === 'Enter') {
      onTimeBlur();
      return;
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
    preventDefault();
    // 基点は確定値ではなく打ちかけの表示値。確定値から動かすと、10:00 と打った
    // 直後の ↑ が打つ前の値を返し、打ったばかりの値が黙って捨てられる。
    const typed = parseIsoTime(time);
    const base = typed === null ? current.totalMinutes : typed.h * 60 + typed.m;
    const stepped = stepTotalMinutes(
      base,
      key === 'ArrowUp' ? kTimeStepMinutes : -kTimeStepMinutes,
    );
    const offset = current.dateOffset + stepped.dayDelta;
    // 選べる範囲の外へは動かさない。上端を素通しさせると、カレンダーでは作れない
    // 日が時刻側から作れてしまう。
    if (offset < first || offset > last) return;
    commit(
      Math.floor(stepped.totalMinutes / 60),
      stepped.totalMinutes % 60,
      dateAt(basis, offset),
    );
  }

  const dateLabel = current.dateLabel(basis);
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      {/* 日付欄はそれ自体が日を示すが、当日・明日という**相対**の読みは別に要る。
          移植元のラベルをそのまま残している。 */}
      {dateLabel !== null && <span className={styles.relative}>{dateLabel}</span>}
      <input
        type="time"
        className={`tabular ${styles.time}`}
        aria-label={ja.timeFieldTime(label)}
        value={time}
        // 確定は blur で行う。ここは打っている最中の見た目を持つだけ。
        // step は置かない。5 分刻みを step へ預けると、その倍数でない時刻
        // （12:03 など）が :invalid として扱われる。刻みは ↑↓ の横取りが持つ。
        min={mode === PickerMode.depart && current.dateOffset === 0 ? clockTime(basis) : undefined}
        onChange={(e) => setTime(e.target.value)}
        onBlur={onTimeBlur}
        onKeyDown={(e) => onTimeKeyDown(e.key, () => e.preventDefault())}
      />
      <input
        type="date"
        className={styles.date}
        aria-label={ja.timeFieldDate(label)}
        value={date}
        min={isoDate(dateAt(basis, first))}
        max={isoDate(dateAt(basis, last))}
        onChange={(e) => setDate(e.target.value)}
        onBlur={onDateBlur}
      />
    </div>
  );
}

/// 外からの変更（到着の自動シフトなど）は映し、打ちかけの欄は触らない入力値。
///
/// 値を state から直に流すと、打ちかけの空文字が毎描画で上書きされて入力できない
/// ——native の時・分は片方だけ埋まっている間、値を空文字として返す。かといって
/// 完全に手元へ持つと、出発を動かして押し出された到着が欄に出ない。
/// 効果ではなく描画中に合わせるのは、1 フレーム古い値がちらつくのを避けるため
/// （React の "adjusting state when props change"）。
function useSyncedInput(value: string): [string, (next: string) => void] {
  const [text, setText] = useState(value);
  const seen = useRef(value);
  if (seen.current !== value) {
    seen.current = value;
    setText(value);
  }
  return [text, setText];
}

/// 暦フィールドで組む。`setDate(getDate() + n)` 相当の加算は、夏時間を跨ぐ日でも
/// 日付そのものは1日進む——[Date] へ Duration を足すと前日 23 時に落ちる。
function dateAt(basis: Date, offset: number): Date {
  return new Date(basis.getFullYear(), basis.getMonth(), basis.getDate() + offset);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function clockTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/// `YYYY-MM-DD` を**ローカルの**その日として読む。`new Date('2026-09-13')` は
/// UTC 深夜として解釈され、日本では9時間ぶん前の日へずれる。
function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function parseIsoTime(value: string): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})/.exec(value);
  if (m === null) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
