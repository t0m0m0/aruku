// 移植元: lib/features/home/home_widgets.dart の _IconHit / _IconHitState。
//
// アイコンだけのボタン。見た目は中身の大きさに留めつつ、タップ領域は HIG の最小
// 寸法まで広げる。非同期の処理を渡すと、終わるまで待ち表示にして押せなくする。

import { useState, type ReactNode } from 'react';

import { ja } from '../i18n/ja';
import styles from './icon-hit-button.module.css';

interface IconHitButtonProps {
  /// 読み上げ名。中身はアイコンなので、名前はここだけが持つ。
  label: string;

  /// 待っている間に読み上げる文言。スピナーは見える読者にしか届かない。
  busyLabel?: string;

  onPress: () => void | Promise<void>;
  children: ReactNode;
  className?: string;
}

export function IconHitButton({
  label,
  busyLabel = ja.busyDefault,
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
    // 成否どちらでも押せる状態へ戻す。
    //
    // 拒否を再送しない（`.finally` にしない）。ボタンには失敗を出す場所が無く、
    // 出すのは呼び出し側の仕事だから——`refreshLocation` は失敗を unavailable へ
    // 畳んで「取得失敗」と表示する。再送しても握る先が無く、unhandledrejection に
    // なるだけで、誰も読まないログが増える。
    const done = () => {
      setBusy(false);
    };
    void result.then(done, done);
  };

  return (
    <button
      type="button"
      className={`${styles.button} ${className ?? ''}`}
      aria-label={label}
      disabled={busy}
      onClick={handleClick}
    >
      {busy ? (
        <span className={styles.spinner}>
          <span role="status" className="srOnly">
            {busyLabel}
          </span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}
