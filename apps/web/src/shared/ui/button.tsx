// shadcn/ui の Button（new-york）。移植元は flutter-final:lib/shared/widgets/aruku_button.dart。
//
// 原本から外したもの:
// - `[&_svg:not([class*='size-'])]:size-4`。アイコンは width 属性で寸法を持っており
//   （shared/icons.tsx）、クラスで 16px へ揃えると CTA のアイコンが黙って縮む
// - `dark:` の分岐。ダークテーマをまだ持たない

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/shared/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2.5 font-[inherit] whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary font-extrabold text-primary-foreground hover:bg-primary/90',
        outline:
          'border border-border bg-card font-bold text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'font-bold text-ink-2 hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'min-h-13 w-full rounded-[16px] px-3 text-base',
        sm: 'h-[38px] gap-[7px] rounded-[11px] px-4 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  // 原本は type を付けない。form の中に置くと既定の submit で送信してしまう。
  type = 'button',
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
