// 移植元: flutter-final:lib/features/picker/（date_time_picker_sheet.dart 全体と
// desktop_time_field.dart の欄まわり）。
//
// 移植元はモバイルのホイールシートとデスクトップの自作欄・月グリッドを別々に
// 持っていた。ここでは native の `<input type="time">` / `<input type="date">`
// 1 組に畳んでいる——どちらもブラウザが端末に合わせた UI（スマホならホイール、
// デスクトップならキー入力とカレンダー）を出す。
//
// 例外はデスクトップ幅の日付で、shadcn の Calendar を開くボタンにしている（#424）。
// 全幅を Calendar にしないのは、モバイル幅で端末のホイールを手放すことになるため。
//
// 「押しても開かないボタン」を避けるため、値を出すだけだった home の欄はこれに
// 置き換わる（#386 スライス2 の申し送り）。

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import {
  PickerMode,
  TimeValue,
  calendarDaysBetween,
  dateOffsetFrom,
} from '@aruku/engine/models/time-value';

import { pickerDateLabel } from '../../i18n/format';
import { ja } from '../../i18n/ja';
import { useIsDesktop } from '../../layout/use-is-desktop';
import { CalendarIcon, ChevronIcon, ClockIcon } from '../../shared/icons';
import { Calendar } from '../../shared/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../shared/ui/popover';
import { cn } from '../../shared/utils';
import type { AppStore, Now } from '../../state/store';
import {
  clampDepartureMinutes,
  firstSelectableOffset,
  kTimeStepMinutes,
  lastSelectableOffset,
  stepTotalMinutes,
} from './time-field-range';

interface TimeFieldProps {
  store: StoreApi<AppStore>;
  mode: PickerMode;
  label: string;

  /// 現在時刻の供給元。過去時刻の切り上げと、選べる日付の範囲の基準に使う。
  now?: Now;
}

export function TimeField({ store, mode, label, now = () => new Date() }: TimeFieldProps) {
  const isDesktop = useIsDesktop();
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const current = mode === PickerMode.depart ? departure : arrival;

  // 状態の dateOffset が数えている起点の日。ストアが持つ（[RouteCore.dateBasis]）。
  //
  // 欄の中で `now()` を読んではいけない。打鍵による再描画で基準だけが新しい日へ進み、
  // 状態の側は古い日のまま取り残される——差が 0 に見えるので詰め直しが走らない。
  // 欄ごとに ref で留めるのも足りない。出発の欄が詰め直しても到着の欄の基準は
  // 古いままで、そちらを確定すると同じ1日をもう一度適用する（PR #399 のレビュー）。
  const basis = useStore(store, (s) => s.dateBasis);

  // 時刻と日付は1つの下書きとして扱う。片方の blur でもう片方を待たずに確定すると、
  // 「正午に 09:00 と打ってから明日を選ぶ」が壊れる——時刻だけが今日の過去時刻として
  // 12:00 へ切り上げられ、続く日付の確定がその値を読む（PR #399 の Codex レビュー）。
  const timeDraft = useDraft(current.format());
  const dateDraft = useDraft(isoDate(dateAt(basis, current.dateOffset)));
  const group = useRef<HTMLDivElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  // カレンダーは portal で欄の外へ描かれる。そこへの移動も「欄の中」として数える。
  const calendar = useRef<HTMLDivElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const selectedDate = dateAt(basis, current.dateOffset);
  const first = firstSelectableOffset(mode, departure);
  const last = lastSelectableOffset(mode, departure, current);

  /// 詰め直してから、確定に使う時計を返す。
  ///
  /// 跨いでいなくても（0 でも）通す。「今すぐ」の出発は保持している h/m が起動時刻の
  /// まま古び、applyPickedTime の「出発 < 到着」の比較がその古い値を見る——09:00 に
  /// 開いて正午に 13:00 着を選ぶと予算 4 時間として記録され、startSearch が出発だけを
  /// 正午へ更新した結果 16:00 着を探しに行く（PR #399 の Codex レビュー）。
  function rebased(): Date {
    const closed = now();
    store
      .getState()
      .rebaseDates(calendarDaysBetween({ from: basis, to: closed }), closed);
    return closed;
  }

  /// 下書きを確定する。
  ///
  /// 触られていない側は詰め直し後の状態から採る。欄が出している値をそのまま使うと、
  /// 詰め直しが引き上げた時刻や日付を、古い表示で上書きしてしまう。
  ///
  /// [over.time] は ↑↓ が入れる時刻。下書きへ書いてから読み直せないのは、React の
  /// state が同じハンドラの中では古いままだから——書いた直後に読むと1つ前の値が返る。
  /// [over.dayShift] は ↑↓ の日送り。[over.date] はカレンダーで選んだ日。
  function commit(over: { time?: string; dayShift?: number; date?: Date } = {}): void {
    const dayShift = over.dayShift ?? 0;
    const timeText = over.time ?? timeDraft.text;
    const timeEdited = over.time !== undefined || timeDraft.edited;
    const dateEdited = over.date !== undefined || dateDraft.edited;
    if (!timeEdited && !dateEdited && dayShift === 0) return;

    const closed = rebased();
    const state = store.getState();
    const settled = currentOf(state);

    let { h, m } = settled;
    if (timeEdited) {
      const parsed = parseIsoTime(timeText);
      // 読めない値は「消しただけ」であって時刻の指定ではない。
      if (parsed === null) {
        settle();
        return;
      }
      ({ h, m } = parsed);
    }

    let dateOffset = settled.dateOffset + dayShift;
    if (dateEdited) {
      const picked = over.date ?? parseIsoDate(dateDraft.text);
      // 選んでいる間に過ぎてしまった日は捨てる。dateOffsetFrom は負を 0 へ丸めるので、
      // そのまま確定すると古い時刻と新しい今日が組み合わさり、詰め直した予定を
      // 引きずり降ろす。日付を**選んだとき**だけ見るのは、欄が出しているだけの日付は
      // 保持値の描画であって絶対日付の指定ではないため。
      if (picked === null || calendarDaysBetween({ from: closed, to: picked }) < 0) {
        settle();
        return;
      }
      dateOffset =
        dateOffsetFrom({
          picked,
          now: closed,
          maxOffset: lastSelectableOffset(mode, state.departure, settled),
        }) + dayShift;
    }

    // 選べる範囲の外へは動かさない。上端を素通しさせると、カレンダーでは作れない
    // 日が時刻側（↑↓ の日送り）から作れてしまう。
    if (
      dateOffset < firstSelectableOffset(mode, state.departure) ||
      dateOffset > lastSelectableOffset(mode, state.departure, settled)
    ) {
      settle();
      return;
    }

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
    settle();
  }

  /// 確定した値を欄へ書き戻す（移植元 `_syncFromState`）。
  ///
  /// 寄せた先が元の値と同じときは state が変わらず、描画中の同期が働かない——打った
  /// 値が欄に残り、状態と食い違ったまま検索へ行く。
  function settle(): void {
    const state = store.getState();
    const current = currentOf(state);
    timeDraft.settle(current.format());
    dateDraft.settle(isoDate(dateAt(state.dateBasis, current.dateOffset)));
  }

  function currentOf(state: { departure: TimeValue; arrival: TimeValue }): TimeValue {
    return mode === PickerMode.depart ? state.departure : state.arrival;
  }

  /// 欄を離れたときに確定する（移植元 `_commitText`）。
  ///
  /// 打っている途中では確定しない。時・分は1桁ずつ来るので、`23:58` と打つ途中に
  /// `02:58` が現れる——それを確定すると過去時刻の切り上げが割り込み、打った値ごと
  /// 現在時刻へ差し替わる（実ブラウザで確認）。
  ///
  /// 同じ欄の中（時刻↔日付↔カレンダー）の移動では確定しない。下書きは対で意味を持つ。
  function onBlur(movedTo: EventTarget | null): void {
    if (
      movedTo instanceof Node &&
      (group.current?.contains(movedTo) === true || calendar.current?.contains(movedTo) === true)
    ) {
      return;
    }
    commit();
  }

  /// 幅が境界を跨いで日付欄が入れ替わったら、カレンダーを閉じ、焦点が欄の外へ
  /// 落ちていれば下書きを確定する。
  ///
  /// 確定は blur に任せているが、日付欄やカレンダーは欄ごと外れるので blur が来ない。
  /// 下書き自体はこの部品が持っているので残るが、確定されないまま検索へ行ける。
  /// 焦点がまだ欄の中（時刻を打っている途中）なら確定しない——blur が後で来るうえ、
  /// ここで確定すると打ちかけの空文字で欄が元の値へ戻される。
  const shownDesktop = useRef(isDesktop);
  useEffect(() => {
    if (shownDesktop.current === isDesktop) return;
    shownDesktop.current = isDesktop;
    setCalendarOpen(false);
    if (group.current?.contains(document.activeElement) === true) return;
    commit();
  });

  /// カレンダーを開く前に、日を跨いでいれば基準日を今日へ詰め直す。
  ///
  /// 基準日は確定まで古いまま残る。そのまま描くと昨日を「今日」として選ばせ、
  /// 選んだ日は確定で「過ぎた日」として捨てられる。
  ///
  /// 打ちかけの時刻があるときは、詰め直しだけを先に走らせない。状態の時刻が動くと
  /// 欄は外からの変更として下書きを捨て、選んだ日は詰め直した時刻で確定する。
  /// その時刻を確定する（確定が同じ詰め直しを含む）。跨いでいないときに確定しない
  /// のは、時刻を打ってから日を選ぶ組を崩さないため（PR #399）。
  function onCalendarOpenChange(open: boolean): void {
    if (open) {
      const at = now();
      if (timeDraft.edited && calendarDaysBetween({ from: basis, to: at }) !== 0) {
        commit();
      } else {
        store.getState().rebaseToToday(at);
      }
    }
    setCalendarOpen(open);
  }

  /// カレンダーで日を選んだ。打ちかけの時刻と対で確定する。
  function onPickDay(picked: Date): void {
    setCalendarOpen(false);
    commit({ date: picked });
  }

  /// ↑↓ を横取りして、日をまたぐ刻みでは日付も一緒に動かす。
  ///
  /// native の ↑↓ は同日内で折り返す。23:58 の5分後が「同じ日の 00:03」になると、
  /// 翌日のままの到着との予算が1時間から25時間近くへ膨らむ。
  function onTimeKeyDown(key: string, preventDefault: () => void): void {
    // Enter は「打ち終えた」の合図。欄を離れずに検索へ行けるようにする。
    if (key === 'Enter') {
      commit();
      return;
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
    preventDefault();
    stepBy(key === 'ArrowUp' ? kTimeStepMinutes : -kTimeStepMinutes);
  }

  /// 5 分刻みで動かす。↑↓ とステッパーの両方がここを通る。
  function stepBy(deltaMinutes: number): void {
    // 基点は確定値ではなく打ちかけの表示値。確定値から動かすと、10:00 と打った
    // 直後の ↑ が打つ前の値を返し、打ったばかりの値が黙って捨てられる。
    const typed = parseIsoTime(timeDraft.text);
    const base = typed === null ? current.totalMinutes : typed.h * 60 + typed.m;
    const stepped = stepTotalMinutes(base, deltaMinutes);
    commit({
      time: `${pad2(Math.floor(stepped.totalMinutes / 60))}:${pad2(stepped.totalMinutes % 60)}`,
      dayShift: stepped.dayDelta,
    });
  }

  return (
    // 欄はカードの中に並ぶので、枠はカードが引いている。
    <div className="min-w-0 flex-1 px-3 py-2" ref={group}>
      <span className="block text-[11px] font-bold tracking-[0.06em] text-ink-2">{label}</span>
      {/* 移植元の「明日」「M/D(曜)」ラベル（TimeValue.dateLabel）は運ばない。
          日付欄と同じ日を二重に出すことになる。 */}
      <div className={row}>
        <span data-testid="time-icon" className={leadingIcon} onClick={() => openPicker(timeInput.current)}>
          <ClockIcon size={18} />
        </span>
        <input
          ref={timeInput}
          type="time"
          className={cn(value, nativeValue)}
          aria-label={ja.timeFieldTime(label)}
          value={timeDraft.text}
          // 確定は blur で行う。ここは打っている最中の見た目を持つだけ。
          // step は置かない。5 分刻みを step へ預けると、その倍数でない時刻
          // （12:03 など）が :invalid として扱われる。刻みは ↑↓ の横取りが持つ。
          min={mode === PickerMode.depart && current.dateOffset === 0 ? clockTime(basis) : undefined}
          onChange={(e) => timeDraft.edit(e.target.value)}
          onBlur={(e) => onBlur(e.relatedTarget)}
          onKeyDown={(e) => onTimeKeyDown(e.key, () => e.preventDefault())}
        />
        {/* マウスでも 5 分刻みで動かせるようにする（移植元 desktop_time_field.dart の
            ステッパー）。native のスピナーでは分が 1 ずつ動き、しかも同日内で折り返す
            ——23:58 から進めても翌日にならない。ここは stepTotalMinutes を通る。

            モバイル幅で出さないのは、端末のホイール UI が同じ役目を持つため。 */}
        {isDesktop && (
          <Steppers
            earlier={ja.timeFieldEarlier(label)}
            later={ja.timeFieldLater(label)}
            onStep={(dir) => stepBy(dir * kTimeStepMinutes)}
            onBlur={onBlur}
          />
        )}
      </div>
      <div className={row}>
        {isDesktop ? (
          <>
            <Popover open={calendarOpen} onOpenChange={onCalendarOpenChange}>
              {/* アイコンをボタンの外へ出すと、フォーカスを取れないアイコンへの押下で
                  時刻欄の blur が relatedTarget なしで走り、打ちかけの時刻を日付より先に
                  確定してしまう（PR #436 の Codex レビュー）。下線はボタンでなく文字に引く。 */}
              <PopoverTrigger
                className={cn(focusRing, 'group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left')}
                aria-label={ja.timeFieldDateButton(label, pickerDateLabel(selectedDate, current.dateOffset))}
                onBlur={(e) => onBlur(e.relatedTarget)}
              >
                <span data-testid="date-icon" className={leadingIcon}>
                  <CalendarIcon size={18} />
                </span>
                <span
                  className={cn(
                    valueText,
                    underline,
                    'truncate group-hover:border-ink-3 group-focus:border-moss-600 group-aria-expanded:border-moss-600',
                  )}
                >
                  {pickerDateLabel(selectedDate, current.dateOffset)}
                </span>
              </PopoverTrigger>
              <PopoverContent
                ref={calendar}
                aria-label={ja.timeFieldDate(label)}
                align="start"
                className="w-auto p-0"
                onBlur={(e) => onBlur(e.relatedTarget)}
              >
                <Calendar
                  mode="single"
                  required
                  selected={selectedDate}
                  onSelect={onPickDay}
                  defaultMonth={selectedDate}
                  today={basis}
                  startMonth={dateAt(basis, first)}
                  endMonth={dateAt(basis, last)}
                  disabled={[{ before: dateAt(basis, first) }, { after: dateAt(basis, last) }]}
                />
              </PopoverContent>
            </Popover>
            <Steppers
              earlier={ja.timeFieldPrevDay(label)}
              later={ja.timeFieldNextDay(label)}
              earlierDisabled={current.dateOffset <= first}
              laterDisabled={current.dateOffset >= last}
              onStep={(dir) => commit({ dayShift: dir })}
              onBlur={onBlur}
            />
          </>
        ) : (
          <>
            <span data-testid="date-icon" className={leadingIcon} onClick={() => openPicker(dateInput.current)}>
              <CalendarIcon size={18} />
            </span>
            <input
              ref={dateInput}
              type="date"
              className={cn(value, nativeValue)}
              aria-label={ja.timeFieldDate(label)}
              value={dateDraft.text}
              min={isoDate(dateAt(basis, first))}
              max={isoDate(dateAt(basis, last))}
              onChange={(e) => dateDraft.edit(e.target.value)}
              onBlur={(e) => onBlur(e.relatedTarget)}
            />
          </>
        )}
      </div>
    </div>
  );
}

const row = 'mt-2 flex items-center gap-1.5';

/// 時刻と日付で同じ大きさにそろえる。モバイル幅で一段下げるのは、360px 幅の端末で
/// native の日付（2026/10/05）が欄に収まらないため。
const valueText =
  'min-w-0 flex-1 bg-transparent text-[15px] desktop:text-[16px] leading-6 font-semibold tabular-nums text-ink';

/// 下線で「書き換えられる欄」であることを示す（Google マップの日時欄）。行ではなく
/// 値に引くのは、行に引くと先頭のアイコンと ◀▶ まで線に乗り、上下の行の線に
/// 値が挟まれて見えるため。
const underline = 'border-b border-ink-4 pb-0.5';
const focusRing =
  'focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-moss-700';
const value = cn(valueText, underline, focusRing, 'hover:border-ink-3 focus:border-moss-600');

/// UA のアイコンは隠す。先頭のアイコンが同じ役目を持ち、二つ並ぶと重複する。
/// 内側の上下 1px の詰めも UA 既定へ戻す——Tailwind の preflight が 0 に均し、
/// 時刻欄と日付欄で行の高さがずれる。
const nativeValue =
  '[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:py-px';

const leadingIcon = 'shrink-0 cursor-pointer text-ink-2';

/// 先頭のアイコンから OS のピッカーを開く。
///
/// 端末では欄を押せば開くが、デスクトップのブラウザを狭めた幅では、UA のアイコンを
/// 隠すとマウスで開く手段がここしか残らない。showPicker を持たないブラウザ
/// （Safari 16 未満）や、開けない状況で投げる例外は握りつぶす——欄そのものは
/// キー入力で使えるので、開かないだけで済む。
function openPicker(input: HTMLInputElement | null): void {
  if (input === null || typeof input.showPicker !== 'function') return;
  input.focus();
  try {
    input.showPicker();
  } catch {
    // 上の理由で黙る。
  }
}

interface SteppersProps {
  earlier: string;
  later: string;
  earlierDisabled?: boolean;
  laterDisabled?: boolean;
  onStep(dir: 1 | -1): void;
  onBlur(movedTo: EventTarget | null): void;
}

/// ◀ ▶ の対。
///
/// blur を見るのは時刻・日付の欄だけでは足りない。ここへ Tab で入って
/// そのまま欄の外へ出ると、打った値が確定されないまま残り、検索は
/// 古い時刻で走る（PR #407 の Codex レビュー）。
function Steppers({ earlier, later, earlierDisabled, laterDisabled, onStep, onBlur }: SteppersProps) {
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        className={step}
        aria-label={earlier}
        disabled={earlierDisabled}
        onClick={() => onStep(-1)}
        onBlur={(e) => onBlur(e.relatedTarget)}
      >
        <ChevronIcon size={14} dir="left" />
      </button>
      <button
        type="button"
        className={step}
        aria-label={later}
        disabled={laterDisabled}
        onClick={() => onStep(1)}
        onBlur={(e) => onBlur(e.relatedTarget)}
      >
        <ChevronIcon size={14} dir="right" />
      </button>
    </span>
  );
}

const step =
  'grid size-7 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-moss-50 hover:text-moss-700 focus-visible:outline-2 focus-visible:outline-moss-700 disabled:cursor-default disabled:text-ink-4 disabled:hover:bg-transparent';

interface Draft {
  text: string;

  /// 触られたか。触られていない欄が出しているのは**保持値の描画**であって指定では
  /// ないので、確定では状態の側を採る。ここを値の比較で代用すると、同じ値を打ち直した
  /// のか通り抜けただけなのかが区別できない——後者で確定すると「今すぐ」が凍る。
  edited: boolean;

  /// 人が入れた値。
  edit(next: string): void;

  /// 確定した値を書き戻す。触られた印も落ちる。
  settle(next: string): void;
}

/// 外からの変更（到着の自動シフトなど）は映し、打ちかけの欄は触らない入力値。
///
/// 値を state から直に流すと、打ちかけの空文字が毎描画で上書きされて入力できない
/// ——native の時・分は片方だけ埋まっている間、値を空文字として返す。かといって
/// 完全に手元へ持つと、出発を動かして押し出された到着が欄に出ない。
/// 効果ではなく描画中に合わせるのは、1 フレーム古い値がちらつくのを避けるため
/// （React の "adjusting state when props change"）。
function useDraft(value: string): Draft {
  const [text, setText] = useState(value);
  const [edited, setEdited] = useState(false);
  const seen = useRef(value);
  if (seen.current !== value) {
    seen.current = value;
    setText(value);
    setEdited(false);
  }
  return {
    text,
    edited,
    edit(next: string) {
      setText(next);
      setEdited(true);
    },
    settle(next: string) {
      seen.current = next;
      setText(next);
      setEdited(false);
    },
  };
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
