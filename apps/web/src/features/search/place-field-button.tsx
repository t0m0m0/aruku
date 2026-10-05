// モバイル幅の home で、出発地・目的地を入力欄の形で見せるボタン（#430）。
//
// 本物の input にしないのは、この幅では打つ場所が全画面の検索画面だから。欄に
// 焦点を置いてから遷移すると、ソフトキーボードが一度開いて閉じる。

import { SearchIcon } from '../../shared/icons';
import { cn } from '../../shared/utils';

/// 入力欄の枠。デスクトップ幅の TypeaheadField と共有し、幅で見た目が変わらないようにする。
export const placeFieldBox =
  'flex h-13 items-center gap-2.5 rounded-[14px] border border-hairline bg-ivory px-3.5 text-ink-3 focus-within:border-moss-400';

interface PlaceFieldButtonProps {
  label: string;

  /// 決まっている地点の名前。null なら placeholder を薄く出す。
  value: string | null;
  placeholder: string;
  onClick: () => void;
}

export function PlaceFieldButton({
  label,
  value,
  placeholder,
  onClick,
}: PlaceFieldButtonProps) {
  const shown = value ?? placeholder;
  return (
    <button
      type="button"
      className={cn(placeFieldBox, 'w-full cursor-pointer text-start outline-none')}
      // 中身から組ませると「出発新宿駅」のように語が繋がる（jsdom と実ブラウザで
      // 区切りが変わる）。ラベルと値を明示する。
      aria-label={`${label} ${shown}`}
      onClick={onClick}
    >
      <SearchIcon size={17} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[15.5px] font-bold text-ink',
          value === null && 'font-semibold text-ink-3',
        )}
      >
        {shown}
      </span>
    </button>
  );
}
