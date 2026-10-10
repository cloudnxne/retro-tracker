/**
 * Rest-timer rules, kept pure so they're unit-tested.
 * The END TIMESTAMP is the source of truth, never an in-memory countdown, so the timer
 * survives the app being backgrounded, locked or killed.
 *
 *   running ──(now ≥ endsAt)──► over ──(chime once, only when visible)──► over, chimed
 *      ▲ +30s (from max(endsAt, now))        │ skip / next set
 *      └─────────────────────────────────────┘
 */
export interface TimerState {
  endsAt: number;
  totalSec: number;
}

/** Milliseconds left; negative once rest is over ("REST OVER +0:42"). */
export const remainingMs = (t: TimerState, now: number) => t.endsAt - now;

/**
 * Chime exactly once per timer, and only while the app is visible (a backgrounded PWA
 * can't reliably play sound; it chimes on return instead).
 */
export function shouldChime(t: TimerState, lastChimedFor: number | null, visible: boolean, now: number): boolean {
  return visible && now >= t.endsAt && lastChimedFor !== t.endsAt;
}

/** +30s: extends from now if rest is already over, so "+30s" always means 30 more seconds. */
export function addTime(t: TimerState, sec: number, now: number): TimerState {
  return { endsAt: Math.max(t.endsAt, now) + sec * 1000, totalSec: t.totalSec + sec };
}

export function start(sec: number, now: number): TimerState {
  return { endsAt: now + sec * 1000, totalSec: sec };
}

/** 0..1 for the progress bar. */
export const progress = (t: TimerState, now: number) =>
  Math.max(0, Math.min(1, remainingMs(t, now) / (t.totalSec * 1000)));
