import { SearchIcon } from '../../shared/icons';
import { cn } from '../../shared/utils';

export const placeFieldBox =
  'flex h-13 items-center gap-2.5 rounded-[14px] border border-hairline bg-ivory px-3.5 text-ink-3 focus-within:border-moss-400';

interface PlaceFieldButtonProps {
  label: string;

  value: string | null;
  placeholder: string;
  onClick: () => void;
}

export function PlaceFieldButton({ label, value, placeholder, onClick }: PlaceFieldButtonProps) {
  const shown = value ?? placeholder;
  return (
    <button
      type="button"
      className={cn(placeFieldBox, 'w-full cursor-pointer text-start outline-none')}
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
