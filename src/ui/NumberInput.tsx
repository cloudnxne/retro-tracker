import { useEffect, useRef } from 'react';

/**
 * Type a number with the phone's own number keyboard ("type in weight
 * instead of using arrows"). Shows `display` until edited; everything typed is cleaned to digits
 * and one decimal point (a comma counts as the point). Enter = done.
 */
export function NumberInput({
  label,
  display,
  typed,
  onType,
  onEnter,
  decimals = true,
  autoFocus = false,
  className,
}: {
  label: string;
  /** Formatted current value, shown when nothing has been typed. */
  display: string;
  /** What the user has typed, or null when untouched. */
  typed: string | null;
  onType: (text: string) => void;
  onEnter?: () => void;
  decimals?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.select();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      className={className ?? 'number-input'}
      aria-label={label}
      type="text"
      inputMode={decimals ? 'decimal' : 'numeric'}
      enterKeyHint="done"
      autoComplete="off"
      value={typed ?? display}
      onFocus={(e) => e.target.select()}
      onChange={(e) => onType(cleanNumber(e.target.value, decimals))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter?.();
        }
      }}
    />
  );
}

/** "82,5kg" → "82.5"; at most one point, at most 6 characters. */
export function cleanNumber(raw: string, decimals = true): string {
  let t = raw.replace(',', '.').replace(/[^0-9.]/g, '');
  const i = t.indexOf('.');
  if (i >= 0) t = decimals ? t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, '') : t.slice(0, i);
  return t.slice(0, 6);
}
