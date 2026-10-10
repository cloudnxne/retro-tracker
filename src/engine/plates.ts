import { DEFAULT_BAR, PLATES } from './rounding';
import type { Units } from './types';

export interface PlateBreakdown {
  /** Plates for ONE side, heaviest first. */
  perSide: number[];
  /** Load the listed plates actually make (may be below target if it isn't loadable). */
  achieved: number;
  exact: boolean;
}

const Q = 20; // work in 0.05 units so fractional plates (1.25, 0.5) stay integers

/**
 * Per-side plate calculator with a limited plate set ("people who don't have
 * 25 kg plates"). Finds the FEWEST plates that make the load exactly; a greedy pick can miss real
 * answers (only 20s and 15s: 30 a side = 15 + 15, but greedy takes a 20 and gets stuck). When the load
 * can't be made, it returns the heaviest load at or below the target. Assumes enough pairs of each size.
 */
export function platesFor(total: number, units: Units, bar = DEFAULT_BAR[units], available: number[] = PLATES[units]): PlateBreakdown {
  const sizes = [...new Set(available.filter((p) => p > 0))].sort((a, b) => b - a);
  const target = Math.max(0, Math.round(((total - bar) / 2) * Q));
  if (!sizes.length || target === 0) return { perSide: [], achieved: bar, exact: target === 0 };
  const units_ = sizes.map((p) => Math.round(p * Q));
  // best[s] = fewest plates summing to s (Infinity = impossible); from[s] = index of last plate used.
  const best = new Array<number>(target + 1).fill(Infinity);
  const from = new Array<number>(target + 1).fill(-1);
  best[0] = 0;
  for (let s = 1; s <= target; s++) {
    for (let i = 0; i < units_.length; i++) {
      const u = units_[i];
      if (u <= s && best[s - u] + 1 < best[s]) {
        best[s] = best[s - u] + 1;
        from[s] = i;
      }
    }
  }
  let s = target;
  while (s > 0 && best[s] === Infinity) s--;
  const perSide: number[] = [];
  for (let k = s; k > 0; k -= units_[from[k]]) perSide.push(sizes[from[k]]);
  perSide.sort((a, b) => b - a);
  const achieved = Math.round((bar + (s / Q) * 2) * 100) / 100;
  return { perSide, achieved, exact: s === target };
}
