import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataDecls, evaluate, extractConst, guessLoadType, parseRange, parseRpe } from './lib.mjs';

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tracker.php'), 'utf8');

describe('parseRange', () => {
  it.each([
    ['6-8', { repMin: 6, repMax: 8 }],
    ['8 – 12', { repMin: 8, repMax: 12 }],
    ['5', { repMin: 5, repMax: 5 }],
    [10, { repMin: 10, repMax: 10 }],
    ['12 each leg', { repMin: 12, repMax: 12 }],
    ['AMRAP', null],
    [null, null],
  ])('%s', (input, expected) => expect(parseRange(input)).toEqual(expected));
});

describe('parseRpe', () => {
  it.each([
    ['7-8', 8],
    ['8', 8],
    [9.5, 9.5],
    ['RPE 7.5', 7.5],
    ['', null],
    [null, null],
    ['hard', null],
  ])('%s', (input, expected) => expect(parseRpe(input)).toBe(expected));
});

describe('guessLoadType', () => {
  it.each([
    ['Bench Press', 'barbell'],
    ['Back Squat', 'barbell'],
    ['DB Shoulder Press', 'dumbbell'],
    ['Hack Squat', 'machine'],
    ['Bulgarian Split Squat', null],
    ['Leg Press', 'machine'],
    ['Cable Row', 'machine'],
    ['Pull-ups', 'bodyweight'],
    ['Farmer carry', null],
  ])('%s', (name, expected) => expect(guessLoadType(name)).toBe(expected));
});

describe('extractConst', () => {
  it('balances brackets across lines and skips strings', () => {
    const decl = extractConst(fixture, 'DEFAULTS');
    expect(decl.startsWith('const DEFAULTS =')).toBe(true);
    expect(decl.trim().endsWith('};')).toBe(true);
  });
  it('keeps semicolons and // inside strings', () => {
    expect(extractConst(fixture, 'NOTE')).toContain('// not a comment";');
  });
  it('follows a multi-line arrow function', () => {
    expect(extractConst(fixture, 'S')).toContain('...extra');
  });
  it('returns null when missing', () => expect(extractConst(fixture, 'NOPE')).toBeNull());
});

describe('evaluate', () => {
  it('finds uppercase consts in order and ignores lowercase', () => {
    expect(dataDecls(fixture)).toEqual(['W', 'S', 'P', 'NOTE', 'DEFAULTS']);
  });
  it('evaluates helpers and data without running UI code', () => {
    const { ctx, found } = evaluate(fixture);
    expect(found.DEFAULTS).toBe(true);
    const bench = ctx.DEFAULTS.phases[0].days[0].exercises[0];
    expect(bench).toMatchObject({ name: 'Bench Press', sets: 3, reps: '6-8', rpe: '7-8', rest: 180, kg: 80 });
    expect(bench.warmups).toEqual([{ kg: 60, reps: 5 }]);
    expect(ctx.document).toBeUndefined();
  });
  it('sandbox has no require/process', () => {
    const { ctx, found } = evaluate('const X = typeof process + typeof require;');
    expect(found.X).toBe(true);
    expect(ctx.X).toBe('undefinedundefined');
  });
});
