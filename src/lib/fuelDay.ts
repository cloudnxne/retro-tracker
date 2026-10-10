/**
 * FUEL dates. Food is filed under the day it was EATEN, keyed YYYY-MM-DD in local time.
 * Before 15:00 the default is yesterday (a morning check-in is about last night's eating); from 15:00
 * it's today. The chip always shows which day, and one tap changes it.
 */
export const FUEL_SWITCH_HOUR = 15;

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Calendar-day arithmetic on local dates: safe across clock changes (a day can be 23 or 25 hours). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}

export function defaultFuelDate(now: Date): string {
  const today = dateKey(now);
  return now.getHours() < FUEL_SWITCH_HOUR ? addDays(today, -1) : today;
}

/** "Today", "Yesterday", or "Mon 28 Sep". */
export function dayLabel(key: string, now: Date): string {
  const today = dateKey(now);
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export const DEFAULT_G_PER_KG = 1.6;
const LB_PER_KG = 2.2046226218;

/** Protein target in grams, rounded to 5 g. Null without a bodyweight: no target is better than a made-up one. */
export function proteinTargetG(gPerKg: number, bodyweight: number | null, units: 'kg' | 'lb'): number | null {
  if (bodyweight == null || !(bodyweight > 0)) return null;
  const kg = units === 'lb' ? bodyweight / LB_PER_KG : bodyweight;
  return Math.round((gPerKg * kg) / 5) * 5;
}
