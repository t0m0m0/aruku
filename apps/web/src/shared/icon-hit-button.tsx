// 移植元: lib/features/home/home_widgets.dart の _IconHit / _IconHitState。
//
// アイコンだけのボタン。見た目は中身の大きさに留めつつ、タップ領域は HIG の最小
// 寸法まで広げる。非同期の処理を渡すと、終わるまで待ち表示にして押せなくする。

import { useState, type ReactNode } from 'react';

import styles from './icon-hit-button.module.css';

interface IconHitButtonProps {
  /// 読み上げ名。中身はアイコンなので、名前はここだけが持つ。
  label: string;

  onPress: () => void | Promise<void>;
  children: ReactNode;
  className?: string;
}

export function IconHitButton({
  label,
  onPress,
  children,
  className,
}: IconHitButtonProps) {
  const [busy, setBusy] = useState(false);

  const handleClick = () => {
    if (busy) return;
    const result = onPress();
    // 同期処理なら待ち表示は出さない。即座に遷移するものが一瞬スピナーに化ける。
    if (!(result instanceof Promise)) return;
    setBusy(true);
    // 失敗しても待ち表示のまま固まらせない。理由は呼び出し側が状態として出す
    // （現在地なら「取得失敗」）ので、ここは押せる状態へ戻すことだけ担う。
    void result.finally(() => {
      setBusy(false);
    });
  };

  return (
    <button
      type="button"
      className={`${styles.button} ${className ?? ''}`}
      aria-label={label}
      disabled={busy}
      onClick={handleClick}
    >
      {busy ? <span role="status" className={styles.spinner} /> : children}
    </button>
  );
}
