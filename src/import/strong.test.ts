import { describe, expect, it } from 'vitest';
import { parseCsv, sniffDelimiter } from './csv';
import { detectFormat, guessLoadType, parseLocalDate, parseStrong } from './strong';

/** Synthetic fixture (invented numbers) covering every row kind seen in a real Strong export. */
import text from './fixtures/strong-sample.csv?raw';

describe('parseCsv', () => {
  it('handles quoted delimiters, doubled quotes, CRLF, BOM and newlines inside quotes', async () => {
    const rows = await parseCsv('﻿"a";"b"\r\n"x;y";"he said ""hi"""\r\n"line\nbreak";""\r\n', { delimiter: ';' });
    expect(rows).toEqual([['a', 'b'], ['x;y', 'he said "hi"'], ['line\nbreak', '']]);
  });
  it('sniffs ; vs , from the header', () => {
    expect(sniffDelimiter('"a";"b";"c"\n1,2')).toBe(';');
    expect(sniffDelimiter('a,b,c\n')).toBe(',');
  });
  it('reports progress and yields on big inputs', async () => {
    const seen: number[] = [];
    const big = 'a,b\n' + '1,2\n'.repeat(5_000);
    const rows = await parseCsv(big, { chunk: 1_000, onProgress: (f) => seen.push(f) });
    expect(rows).toHaveLength(5_001);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(1);
  });
});

describe('detectFormat', () => {
  it('recognises Strong and Hevy headers, rejects others', async () => {
    const [header] = await parseCsv(text);
    expect(detectFormat(header)).toBe('strong');
    expect(detectFormat(['title', 'start_time', 'exercise_title', 'set_type', 'weight_kg'])).toBe('hevy');
    expect(detectFormat(['date', 'exercise', 'kg'])).toBe('unknown');
  });
});

describe('parseStrong (fixture)', () => {
  it('groups rows into workouts and exercises in file order', async () => {
    const p = parseStrong(await parseCsv(text), 'kg');
    expect(p.workouts.map((w) => w.name)).toEqual(['Workout A', 'Workout B']);
    expect(p.workouts[0].exercises.map((e) => e.name)).toEqual(['Squat (Barbell)', 'Pull Up', 'Plank']);
    expect(p.workouts[1].exercises.map((e) => e.name)).toEqual(['Bench Press (Barbell)', 'pause squat']);
  });

  it('maps W → warm-up, F → failure, 0 kg → no load, seconds-only → timed', async () => {
    const [a] = parseStrong(await parseCsv(text), 'kg').workouts;
    const squat = a.exercises[0].sets;
    expect(squat.map((s) => [s.setType, s.sourceSetType, s.kg, s.reps, s.rpe])).toEqual([
      ['warmup', null, 60, 5, null],
      ['straight', null, 100, 5, 8],
      ['straight', null, 100, 5, 8.5],
      ['straight', 'failure', 100, 3, 10],
    ]);
    expect(a.exercises[1].sets[0]).toMatchObject({ kg: null, reps: 8 });
    expect(a.exercises[2].sets[0]).toMatchObject({ kg: null, reps: null, sourceSetType: 'timed:60' });
  });

  it('counts rest timers, notes and cardio as skipped, never as sets', async () => {
    const p = parseStrong(await parseCsv(text), 'kg');
    expect(p.skipped).toEqual({ restTimers: 1, notes: 1, cardio: 1 });
    expect(p.setCount).toBe(9); // A: 4 squat + pull-up + plank; B: 2 bench + pause squat
  });

  it('turns bad rows into named errors with spreadsheet row numbers and leaves them out', async () => {
    const p = parseStrong(await parseCsv(text), 'kg');
    expect(p.errors).toEqual([
      { row: 14, message: 'date "2024-13-40 10:00:00" not recognised' },
      { row: 15, message: 'weight, reps, RPE or seconds is not a number' },
    ]);
    expect(p.workouts.some((w) => w.name === 'Broken')).toBe(false);
  });

  it('uses local wall-clock time and the workout duration', async () => {
    const [, b] = parseStrong(await parseCsv(text), 'kg').workouts;
    expect(b.startedAt).toBe(new Date(2024, 0, 10, 7, 30, 15).getTime());
    expect(b.completedAt - b.startedAt).toBe(2_700_000);
    expect(b.key).toBe('2024-01-10 07:30:15');
  });

  it('converts to the account units', async () => {
    const [, b] = parseStrong(await parseCsv(text), 'lb').workouts;
    expect(b.exercises[0].sets[0].kg).toBe(155.4); // 70.5 kg
  });

  it('rejects impossible dates', () => {
    expect(parseLocalDate('2024-02-30 10:00:00')).toBeNull();
    expect(parseLocalDate('2024-02-29 10:00:00')).toBe(new Date(2024, 1, 29, 10, 0, 0).getTime());
    expect(parseLocalDate('2024-01-10T07:30:15')).toBeNull();
    expect(parseLocalDate('')).toBeNull();
  });
});

describe('guessLoadType', () => {
  it.each([
    ['Squat (Barbell)', false, 'barbell', true],
    ['Hammer Curl (Dumbbell)', false, 'dumbbell', true],
    ['Lat Pulldown (Cable)', false, 'machine', true],
    ['Leg Extension (Machine)', false, 'machine', true],
    ['Pull Up (Assisted)', false, 'bodyweight', true],
    ['Pull Up', true, 'bodyweight', true],
    ['pause squat', false, 'barbell', false],
  ])('%s', (name, empty, loadType, certain) => expect(guessLoadType(name, empty)).toEqual({ loadType, certain }));
});
