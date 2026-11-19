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

  now?: Now;
}

export function TimeField({ store, mode, label, now = () => new Date() }: TimeFieldProps) {
  const isDesktop = useIsDesktop();
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const current = mode === PickerMode.depart ? departure : arrival;

  const basis = useStore(store, (s) => s.dateBasis);

  const timeDraft = useDraft(current.format());
  const dateDraft = useDraft(isoDate(dateAt(basis, current.dateOffset)));
  const group = useRef<HTMLDivElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const calendar = useRef<HTMLDivElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const selectedDate = dateAt(basis, current.dateOffset);
  const first = firstSelectableOffset(mode, departure);
  const last = lastSelectableOffset(mode, departure, current);

  function rebased(): Date {
    const closed = now();
    store.getState().rebaseDates(calendarDaysBetween({ from: basis, to: closed }), closed);
    return closed;
  }

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
      if (parsed === null) {
        settle();
        return;
      }
      ({ h, m } = parsed);
    }

    let dateOffset = settled.dateOffset + dayShift;
    if (dateEdited) {
      const picked = over.date ?? parseIsoDate(dateDraft.text);
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

    if (
      dateOffset < firstSelectableOffset(mode, state.departure) ||
      dateOffset > lastSelectableOffset(mode, state.departure, settled)
    ) {
      settle();
      return;
    }

    let total = h * 60 + m;
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

  function settle(): void {
    const state = store.getState();
    const current = currentOf(state);
    timeDraft.settle(current.format());
    dateDraft.settle(isoDate(dateAt(state.dateBasis, current.dateOffset)));
  }

  function currentOf(state: { departure: TimeValue; arrival: TimeValue }): TimeValue {
    return mode === PickerMode.depart ? state.departure : state.arrival;
  }

  function onBlur(movedTo: EventTarget | null): void {
    if (
      movedTo instanceof Node &&
      (group.current?.contains(movedTo) === true || calendar.current?.contains(movedTo) === true)
    ) {
      return;
    }
    commit();
  }

  const shownDesktop = useRef(isDesktop);
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (shownDesktop.current === isDesktop) return;
    shownDesktop.current = isDesktop;
    setCalendarOpen(false);
    if (group.current?.contains(document.activeElement) === true) return;
    commit();
  });

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

  function onPickDay(picked: Date): void {
    setCalendarOpen(false);
    commit({ date: picked });
  }

  function onTimeKeyDown(key: string, preventDefault: () => void): void {
    if (key === 'Enter') {
      commit();
      return;
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
    preventDefault();
    stepBy(key === 'ArrowUp' ? kTimeStepMinutes : -kTimeStepMinutes);
  }

  function stepBy(deltaMinutes: number): void {
    const typed = parseIsoTime(timeDraft.text);
    const base = typed === null ? current.totalMinutes : typed.h * 60 + typed.m;
    const stepped = stepTotalMinutes(base, deltaMinutes);
    commit({
      time: `${pad2(Math.floor(stepped.totalMinutes / 60))}:${pad2(stepped.totalMinutes % 60)}`,
      dayShift: stepped.dayDelta,
    });
  }

  return (
    <div className="min-w-0 flex-1 px-3 py-2" ref={group}>
      <span className="block text-[11px] font-bold tracking-[0.06em] text-ink-2">{label}</span>
      <div className={row}>
        <span
          data-testid="time-icon"
          className={leadingIcon}
          onClick={() => openPicker(timeInput.current)}
        >
          <ClockIcon size={18} />
        </span>
        <input
          ref={timeInput}
          type="time"
          className={cn(value, nativeValue)}
          aria-label={ja.timeFieldTime(label)}
          value={timeDraft.text}
          min={
            mode === PickerMode.depart && current.dateOffset === 0 ? clockTime(basis) : undefined
          }
          onChange={(e) => timeDraft.edit(e.target.value)}
          onBlur={(e) => onBlur(e.relatedTarget)}
          onKeyDown={(e) => onTimeKeyDown(e.key, () => e.preventDefault())}
        />
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
              <PopoverTrigger
                className={cn(
                  focusRing,
                  'group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left',
                )}
                aria-label={ja.timeFieldDateButton(
                  label,
                  pickerDateLabel(selectedDate, current.dateOffset),
                )}
                onBlur={(e) => onBlur(e.relatedTarget)}
              >
                <span data-testid="date-icon" className={leadingIcon}>
                  <CalendarIcon size={18} />
                </span>
                <span
                  className={cn(
                    valueText,
                    underline,
                    'truncate group-hover:border-ink/35 group-focus:border-moss-600 group-aria-expanded:border-moss-600',
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
            <span
              data-testid="date-icon"
              className={leadingIcon}
              onClick={() => openPicker(dateInput.current)}
            >
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

const valueText =
  'min-w-0 flex-1 bg-transparent text-[15px] desktop:text-[16px] leading-6 font-semibold tabular-nums text-ink';

const underline = 'border-b border-ink/20 pb-0.5';
const focusRing =
  'focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-moss-700';
const value = cn(valueText, underline, focusRing, 'hover:border-ink/35 focus:border-moss-600');

const nativeValue =
  '[&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:py-px';

const leadingIcon = 'shrink-0 cursor-pointer text-ink-2';

function openPicker(input: HTMLInputElement | null): void {
  if (input === null || typeof input.showPicker !== 'function') return;
  input.focus();
  try {
    input.showPicker();
  } catch {}
}

interface SteppersProps {
  earlier: string;
  later: string;
  earlierDisabled?: boolean;
  laterDisabled?: boolean;
  onStep: (dir: 1 | -1) => void;
  onBlur: (movedTo: EventTarget | null) => void;
}

function Steppers({
  earlier,
  later,
  earlierDisabled,
  laterDisabled,
  onStep,
  onBlur,
}: SteppersProps) {
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

  edited: boolean;

  edit(next: string): void;

  settle(next: string): void;
}

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

function dateAt(basis: Date, offset: number): Date {
  return new Date(basis.getFullYear(), basis.getMonth(), basis.getDate() + offset);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function clockTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

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
