import { describe, expect, it } from 'vitest';
import { classify, deloadPrescription, suggestNext } from './progression';
import { increaseStep, loadStep, roundDownLoadable } from './rounding';
import { platesFor } from './plates';
import { e1rm } from './e1rm';
import { advance, blockForWeek, isDeloadWeek, shouldOfferEarlyDeload, type Block } from './schedule';
import { suggestionLine } from './copy';
import type { ExerciseLoad, ExerciseSessionResult, Prescription } from './types';

const bench: ExerciseLoad = { loadType: 'barbell' };
const db: ExerciseLoad = { loadType: 'dumbbell' };
const machine: ExerciseLoad = { loadType: 'machine', loadIncrement: 5 };
const pullup: ExerciseLoad = { loadType: 'bodyweight' };
const rx: Prescription = { sets: 3, repMin: 6, repMax: 8, targetRpe: 8 };

const session = (
  kg: number | null,
  reps: number[],
  rpe: (number | null)[] = [],
  opts: Partial<ExerciseSessionResult> = {},
): ExerciseSessionResult => ({
  sets: reps.map((r, i) => ({ kg, reps: r, rpe: rpe[i] ?? null, completed: true })),
  isDeload: false,
  prescription: rx,
  ...opts,
});

describe('progression table (first match wins)', () => {
  it('row 3: every set at the top and RPE <= target → increase +2.5 kg barbell', () => {
    const s = suggestNext([session(80, [8, 8, 8], [7, 7.5, 8])], rx, bench, 'kg');
    expect(s.outcome).toBe('increase');
    expect(s.weight).toBe(82.5);
    expect(s.repTargets).toEqual([6, 6, 6]);
  });

  it('row 3: reps above the top count as top', () => {
    expect(classify(session(80, [9, 8, 10]))).toBe('increase');
  });

  it('row 3: missing RPE never blocks an increase', () => {
    expect(classify(session(80, [8, 8, 8], [null, null, null]))).toBe('increase');
  });

  it('row 4: at top but RPE between target and target+1 → hold', () => {
    expect(classify(session(80, [8, 8, 8], [8.5, 8, 8]))).toBe('hold');
  });

  it('row 4: in range → hold, +1 rep on the lowest set', () => {
    const s = suggestNext([session(80, [8, 7, 6])], rx, bench, 'kg');
    expect(s.outcome).toBe('hold');
    expect(s.weight).toBe(80);
    expect(s.repTargets).toEqual([8, 7, 7]);
    expect(s.focusSet).toBe(3);
  });

  it('row 2: any set below the bottom → miss, same weight', () => {
    const s = suggestNext([session(80, [8, 6, 5])], rx, bench, 'kg');
    expect(s.outcome).toBe('miss');
    expect(s.weight).toBe(80);
  });

  it('row 2: RPE >= target + 1 → miss even with good reps', () => {
    expect(classify(session(80, [8, 8, 8], [8, 9, 8]))).toBe('miss');
  });

  it('row 2: fewer completed sets than prescribed → miss', () => {
    expect(classify(session(80, [8, 8]))).toBe('miss');
  });

  it('row 2 is checked before row 3 (first match wins)', () => {
    // Top reps on every set, but one set at RPE 9 → miss, not increase.
    expect(classify(session(80, [8, 8, 8], [7, 9, 7]))).toBe('miss');
  });

  it('row 1: second consecutive miss at the same weight → reset −10%, rounded down', () => {
    const s = suggestNext([session(80, [5, 5, 5]), session(80, [6, 5, 5])], rx, bench, 'kg');
    expect(s.outcome).toBe('reset');
    expect(s.weight).toBe(70); // 80 × 0.9 = 72, not loadable → round DOWN to 70
  });

  it('row 1: a miss after a miss at a DIFFERENT weight is just a miss', () => {
    const s = suggestNext([session(80, [5, 5, 5]), session(77.5, [5, 5, 5])], rx, bench, 'kg');
    expect(s.outcome).toBe('miss');
  });

  it('deload sessions are ignored in history', () => {
    const s = suggestNext(
      [session(47.5, [6, 6], [], { isDeload: true }), session(80, [8, 8, 8])],
      rx,
      bench,
      'kg',
    );
    expect(s.outcome).toBe('increase');
    expect(s.weight).toBe(82.5);
  });

  it('no history → first-time, asks for a weight', () => {
    const s = suggestNext([], rx, bench, 'kg');
    expect(s.outcome).toBe('first-time');
    expect(s.weight).toBeNull();
  });

  it('dumbbell increases +2 kg, machine one stack step, lb +5', () => {
    expect(suggestNext([session(20, [8, 8, 8])], rx, db, 'kg').weight).toBe(22);
    expect(suggestNext([session(50, [8, 8, 8])], rx, machine, 'kg').weight).toBe(55);
    expect(suggestNext([session(135, [8, 8, 8])], rx, bench, 'lb').weight).toBe(140);
  });

  it('bodyweight increase adds a rep, not load', () => {
    const s = suggestNext([session(null, [8, 8, 8])], rx, pullup, 'kg');
    expect(s.outcome).toBe('increase');
    expect(s.repTargets).toEqual([9, 9, 9]);
  });
});

describe('rounding and plates', () => {
  it('rounds down to loadable weights per load type', () => {
    expect(roundDownLoadable(71.9, bench, 'kg')).toBe(70);
    expect(roundDownLoadable(72.5, bench, 'kg')).toBe(72.5);
    expect(roundDownLoadable(10, bench, 'kg')).toBe(20); // never below the bar
    expect(roundDownLoadable(23.9, db, 'kg')).toBe(22);
    expect(roundDownLoadable(58, machine, 'kg')).toBe(55);
    expect(roundDownLoadable(137, bench, 'lb')).toBe(135);
  });

  it('plate calculator gives per-side plates heaviest first', () => {
    expect(platesFor(82.5, 'kg').perSide).toEqual([25, 5, 1.25]);
    expect(platesFor(20, 'kg').perSide).toEqual([]);
    expect(platesFor(225, 'lb').perSide).toEqual([45, 45]);
    expect(platesFor(83, 'kg').exact).toBe(false);
  });

  it('e1RM matches the PHP tracker (Epley, 1 rep = load)', () => {
    expect(e1rm(100, 1)).toBe(100);
    expect(e1rm(80, 8)).toBe(101.3);
    expect(e1rm(60, 12, 10)).toBeNull();
  });

  it('deload: 60% rounded down, one set fewer', () => {
    expect(deloadPrescription(100, rx, bench, 'kg')).toEqual({ weight: 60, sets: 2 });
    expect(deloadPrescription(100, { ...rx, sets: 1 }, bench, 'kg').sets).toBe(1);
  });
});

describe('schedule', () => {
  const blocks: Block[] = [
    { id: 'b1', name: 'Base', weeks: 3, dayIds: ['mon', 'wed', 'fri'] },
    { id: 'b2', name: 'Peak', weeks: 2, dayIds: ['mon', 'thu'] },
  ];

  it('deload weeks every 4th from the anchor, never the anchor itself', () => {
    expect([1, 2, 3, 4, 5, 8, 12].map((w) => isDeloadWeek(w, 0))).toEqual([false, false, false, true, false, true, true]);
    expect(isDeloadWeek(6, 6)).toBe(false);
    expect(isDeloadWeek(10, 6)).toBe(true);
    expect(isDeloadWeek(4, 0, 0)).toBe(false);
  });

  it('maps global weeks to blocks and detects the end', () => {
    expect(blockForWeek(blocks, 3)?.block.id).toBe('b1');
    expect(blockForWeek(blocks, 4)).toEqual({ block: blocks[1], weekInBlock: 1 });
    expect(blockForWeek(blocks, 6)).toBeNull();
  });

  it('week advances only when every day is done (missed calendar days never skip)', () => {
    expect(advance(blocks, { week: 1, dayIdx: 0 }, ['mon']).position).toEqual({ week: 1, dayIdx: 1 });
    expect(advance(blocks, { week: 1, dayIdx: 2 }, ['mon', 'wed', 'fri'])).toMatchObject({
      position: { week: 2, dayIdx: 0 },
      weekCompleted: true,
    });
    expect(advance(blocks, { week: 5, dayIdx: 1 }, ['mon', 'thu']).finished).toBe(true);
  });

  it('early deload is offered when 2+ different exercises reset within 7 days', () => {
    const now = Date.UTC(2026, 8, 26);
    const day = 86_400_000;
    expect(shouldOfferEarlyDeload([{ exerciseId: 'bench', at: now - day }, { exerciseId: 'bench', at: now }], now)).toBe(false);
    expect(shouldOfferEarlyDeload([{ exerciseId: 'bench', at: now - 2 * day }, { exerciseId: 'squat', at: now }], now)).toBe(true);
    expect(shouldOfferEarlyDeload([{ exerciseId: 'bench', at: now - 9 * day }, { exerciseId: 'squat', at: now }], now)).toBe(false);
  });
});

describe('suggestion copy', () => {
  it('uses coach-voice lines with the right glyphs', () => {
    const inc = suggestNext([session(80, [8, 8, 8])], rx, bench, 'kg');
    expect(suggestionLine(inc, 'kg', { kg: 80, reps: 8 })).toEqual({
      glyph: '▲',
      text: '82.5 kg · you owned 80 × 8 last time',
    });
    const hold = suggestNext([session(80, [8, 7, 6])], rx, bench, 'kg');
    expect(suggestionLine(hold, 'kg').text).toBe('80 kg · go for 7 on set 3');
    const reset = suggestNext([session(80, [5, 5, 5]), session(80, [5, 5, 5])], rx, bench, 'kg');
    expect(suggestionLine(reset, 'kg')).toEqual({ glyph: '↺', text: '70 kg · reload and build back up' });
  });
});

describe('plates you actually have', () => {
  it('finds the exact fewest-plate answer a greedy pick would miss', () => {
    expect(platesFor(80, 'kg', 20, [20, 15])).toEqual({ perSide: [15, 15], achieved: 80, exact: true });
  });
  it('without 25s, uses 20s', () => {
    expect(platesFor(120, 'kg', 20, [20, 15, 10, 5, 2.5, 1.25]).perSide).toEqual([20, 20, 10]);
  });
  it('fractional plates and a 15 kg bar', () => {
    expect(platesFor(41, 'kg', 15, [10, 2.5, 0.5]).perSide).toEqual([10, 2.5, 0.5]);
  });
  it('a load it cannot make: heaviest below, marked not exact', () => {
    expect(platesFor(85, 'kg', 20, [20, 10, 5])).toEqual({ perSide: [20, 10], achieved: 80, exact: false });
  });
  it('empty bar and below-bar loads', () => {
    expect(platesFor(20, 'kg', 20, [20])).toEqual({ perSide: [], achieved: 20, exact: true });
    expect(platesFor(15, 'kg', 20, [20]).perSide).toEqual([]);
  });
  it('the barbell step follows the smallest plate, and an increase is never smaller than it', () => {
    const noSmall = { loadType: 'barbell' as const, plates: [20, 10, 5, 2.5] };
    expect(loadStep(noSmall, 'kg')).toBe(5);
    expect(increaseStep(noSmall, 'kg')).toBe(5);
    expect(increaseStep({ loadType: 'barbell' }, 'kg')).toBe(2.5);
    expect(roundDownLoadable(102.5, noSmall, 'kg')).toBe(100);
  });
});

describe('plate-loaded machines', () => {
  const sled = { loadType: 'plates' as const, plates: [20, 10, 5, 2.5] };
  it('no bar: the plate calculator starts from zero', () => {
    expect(platesFor(140, 'kg', 0, [20, 10, 5, 2.5]).perSide).toEqual([20, 20, 20, 10]);
    expect(platesFor(0, 'kg', 0, [20])).toEqual({ perSide: [], achieved: 0, exact: true });
  });
  it('rounds to what the plates can load, with no bar', () => {
    expect(roundDownLoadable(143, sled, 'kg')).toBe(140);
    expect(roundDownLoadable(3, sled, 'kg')).toBe(0);
  });
  it('steps by a pair of the smallest plate; increases by a plate each side', () => {
    expect(loadStep(sled, 'kg')).toBe(5);
    expect(increaseStep(sled, 'kg')).toBe(5);
    expect(increaseStep({ loadType: 'plates', plates: [20, 10] }, 'kg')).toBe(20);
    expect(increaseStep({ loadType: 'plates' }, 'lb')).toBe(10);
  });
});
