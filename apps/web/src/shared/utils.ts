import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/// shadcn/ui の部品が前提にするクラス結合。後に書いたユーティリティが勝つ。
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
