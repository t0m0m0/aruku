// shadcn/ui の Calendar（new-york-v4）。react-day-picker の上に載っている。
//
// 原本から外したもの:
// - lucide-react のアイコン。依存を増やさず shared/icons の ChevronIcon で描く
// - 範囲選択・週番号・年月ドロップダウンの装飾。使う画面が単一日の選択だけ
// - buttonVariants の size="icon"。こちらの Button はその寸法を持たない
// - `dark:` と `rtl:` の分岐。ダークテーマも右横書きもまだ持たない
//
// 表記を react-day-picker のロケール（date-fns/locale の ja）で出さないのは、同梱
// フォントの語彙が src の文字列リテラルからしか作られないため
// （vite/font-subset.ts）。node_modules から来た「月」「火」は語彙に入らず豆腐になる。

import type { ComponentProps } from 'react';
import {
  DayButton as DayButtonBase,
  DayPicker,
  getDefaultClassNames,
  type DayButtonProps,
} from 'react-day-picker';

import { todayDateLabel } from '@/i18n/format';
import { ja } from '@/i18n/ja';
import { ChevronIcon } from '@/shared/icons';
import { buttonVariants } from '@/shared/ui/button';
import { cn } from '@/shared/utils';

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  formatters,
  labels,
  components,
  ...props
}: ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames();
  const navButton = cn(
    buttonVariants({ variant: 'ghost', size: 'sm' }),
    'size-(--cell-size) rounded-md p-0 select-none aria-disabled:opacity-50',
  );

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        'group/calendar bg-background p-3 [--cell-size:--spacing(8)] [[data-slot=popover-content]_&]:bg-transparent',
        className,
      )}
      formatters={{
        formatCaption: (month) => ja.calendarCaption(month.getFullYear(), month.getMonth() + 1),
        formatWeekdayName: (weekday) => ja.weekdays[(weekday.getDay() + 6) % 7],
        ...formatters,
      }}
      labels={{
        labelGrid: (month) => ja.calendarCaption(month.getFullYear(), month.getMonth() + 1),
        labelDayButton: (date, modifiers) =>
          ja.calendarDayLabel(todayDateLabel(date), {
            today: modifiers.today === true,
            selected: modifiers.selected === true,
          }),
        labelWeekday: (weekday) => ja.calendarWeekdayLabel(ja.weekdays[(weekday.getDay() + 6) % 7]),
        labelNext: () => ja.calendarNextMonth,
        labelPrevious: () => ja.calendarPreviousMonth,
        ...labels,
      }}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn(
          'absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1',
          defaultClassNames.nav,
        ),
        button_previous: cn(navButton, defaultClassNames.button_previous),
        button_next: cn(navButton, defaultClassNames.button_next),
        month_caption: cn(
          'flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)',
          defaultClassNames.month_caption,
        ),
        caption_label: cn('text-sm font-bold select-none', defaultClassNames.caption_label),
        month_grid: cn('w-full border-collapse', defaultClassNames.month_grid),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'flex-1 rounded-md text-[0.8rem] font-normal text-muted-foreground select-none',
          defaultClassNames.weekday,
        ),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        day: cn(
          'group/day relative aspect-square h-full w-full p-0 text-center select-none',
          defaultClassNames.day,
        ),
        today: cn('rounded-md bg-accent text-accent-foreground', defaultClassNames.today),
        outside: cn('text-muted-foreground', defaultClassNames.outside),
        disabled: cn('text-muted-foreground opacity-50', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => (
          <ChevronIcon size={16} dir={orientation === 'left' ? 'left' : 'right'} />
        ),
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  );
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: DayButtonProps) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayButtonBase
      day={day}
      modifiers={modifiers}
      data-selected-single={modifiers.selected}
      className={cn(
        'flex aspect-square size-auto w-full min-w-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm leading-none font-normal tabular-nums outline-none hover:bg-accent hover:text-accent-foreground focus-visible:relative focus-visible:z-10 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:bg-transparent data-[selected-single=true]:bg-primary data-[selected-single=true]:font-bold data-[selected-single=true]:text-primary-foreground',
        defaultClassNames.day,
        className,
      )}
      {...props}
    />
  );
}

export { Calendar };
