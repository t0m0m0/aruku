// 移植元: flutter-final:lib/features/home/home_widgets.dart の _IconHit / _IconHitState。
//
// アイコンだけのボタン。見た目は中身の大きさに留めつつ、タップ領域は HIG の最小
// 寸法まで広げる。非同期の処理を渡すと、終わるまで待ち表示にして押せなくする。
//
// shadcn の Button（ghost / icon）には乗せない。あちらは hover で領域全体に背景を敷き、
// 中身が自前の背景を持つ場合（home の検索チップ）に 44px 四方の四角が後ろへ浮く。

import { useState, type ReactNode } from 'react';

import { ja } from '../i18n/ja';
import { cn } from './utils';

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
      className={cn(
        'inline-flex size-tap-min flex-none cursor-pointer items-center justify-center text-ink-2 disabled:cursor-default',
        className,
      )}
      aria-label={label}
      disabled={busy}
      onClick={handleClick}
    >
      {busy ? (
        // 「動きを減らす」設定では回さない。待ち表示であることは色差で残す。
        <span className="size-[18px] animate-spin rounded-full border-2 border-ink-4 border-t-ink-2 motion-reduce:animate-none">
          <span role="status" className="sr-only">
            {busyLabel}
          </span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}
