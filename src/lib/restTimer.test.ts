import { describe, expect, it } from 'vitest';
import { addTime, progress, remainingMs, shouldChime, start } from './restTimer';
import { fmtClock } from './useRestTimer';

const T0 = 1_000_000;

describe('rest timer rules', () => {
  it('counts down from the end timestamp', () => {
    const t = start(120, T0);
    expect(remainingMs(t, T0 + 13_000)).toBe(107_000);
    expect(fmtClock(remainingMs(t, T0 + 13_000))).toBe('1:47');
    expect(progress(t, T0 + 60_000)).toBeCloseTo(0.5);
  });

  it('goes negative once over ("REST OVER +0:42")', () => {
    const t = start(60, T0);
    expect(remainingMs(t, T0 + 102_000)).toBe(-42_000);
    expect(fmtClock(remainingMs(t, T0 + 102_000))).toBe('0:42');
    expect(progress(t, T0 + 102_000)).toBe(0);
  });

  it('chimes once when over and visible, never twice for the same timer', () => {
    const t = start(60, T0);
    expect(shouldChime(t, null, true, T0 + 30_000)).toBe(false);
    expect(shouldChime(t, null, true, T0 + 60_000)).toBe(true);
    expect(shouldChime(t, t.endsAt, true, T0 + 61_000)).toBe(false);
  });

  it('backgrounded: no chime while hidden, chimes once on return', () => {
    const t = start(60, T0);
    expect(shouldChime(t, null, false, T0 + 90_000)).toBe(false);
    expect(shouldChime(t, null, true, T0 + 300_000)).toBe(true);
  });

  it('+30s extends from the end while running', () => {
    const t = start(60, T0);
    expect(addTime(t, 30, T0 + 10_000)).toEqual({ endsAt: T0 + 90_000, totalSec: 90 });
  });

  it('+30s after expiry means 30 more seconds from now, and chimes again later', () => {
    const t = start(60, T0);
    const later = addTime(t, 30, T0 + 100_000);
    expect(later.endsAt).toBe(T0 + 130_000);
    expect(shouldChime(later, t.endsAt, true, T0 + 130_000)).toBe(true);
  });

  it('formats hours for very long sessions', () => {
    expect(fmtClock(3_723_000)).toBe('1:02:03');
  });
});
