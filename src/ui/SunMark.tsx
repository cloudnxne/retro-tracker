import { useId } from 'react';

/**
 * The app mark: a setting sun with horizon cuts (the three header bars read
 * as a burger menu). Colours come from the theme's --stripe tokens, so light mode gets its own version.
 */
export function SunMark({ width = 34 }: { width?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="sun-mark" width={width} height={(width * 20) / 36} viewBox="0 0 36 20" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--stripe-1)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--stripe-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--stripe-3)' }} />
        </linearGradient>
        <mask id={`m${id}`}>
          <rect width="36" height="20" fill="#fff" />
          {/* Horizon cuts, widening towards the bottom. */}
          <rect y="10.2" width="36" height="1.1" fill="#000" />
          <rect y="13.4" width="36" height="1.5" fill="#000" />
          <rect y="16.8" width="36" height="1.9" fill="#000" />
        </mask>
      </defs>
      <path d="M1 20 A17 17 0 0 1 35 20 Z" fill={`url(#g${id})`} mask={`url(#m${id})`} />
    </svg>
  );
}
