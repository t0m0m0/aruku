// 移植元: lib/shared/widgets/aruku_button.dart。
//
// 移植元の引数 12 個のうち運んだのは label / onPress / icon / variant だけ。色・角丸・
// 高さ・影・文字スタイルの上書きは、CSS では使う側が className で直接書ける。
// Flutter に引数しか入口が無かったことの都合を持ち込まない。

import type { ReactNode } from 'react';

import styles from './button.module.css';

export type ArukuButtonVariant = 'filled' | 'outlined';

interface ArukuButtonProps {
  label: string;
  onPress: () => void;
  icon?: ReactNode;
  variant?: ArukuButtonVariant;

  /// 押せない状態。移植元は onPressed: null で表していた。
  disabled?: boolean;

  /// 呼び出し側の見た目の上書き（CTA の高さ・影など）。
  className?: string;
}

export function ArukuButton({
  label,
  onPress,
  icon,
  variant = 'filled',
  disabled = false,
  className,
}: ArukuButtonProps) {
  const classes = [styles.button, variant === 'outlined' ? styles.outlined : null, className]
    .filter((c) => c !== null && c !== undefined)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      onClick={onPress}
    >
      {/* アイコンは装飾。読み上げ名はラベルだけが作る（移植元の MergeSemantics）。 */}
      {icon !== undefined && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      {label}
    </button>
  );
}
