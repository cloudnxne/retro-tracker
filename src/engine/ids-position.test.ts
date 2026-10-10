import { describe, expect, it } from 'vitest';
import { exerciseIdFor, normaliseExerciseName, uuidv5 } from './ids';
import { derivePosition, type Block } from './schedule';

describe('exercise ids', () => {
  it('matches the RFC 4122 v5 test vector', async () => {
    expect(await uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('normalises case, punctuation and spacing', () => {
    expect(normaliseExerciseName('  Bench-Press (Barbell) ')).toBe('bench press barbell');
    expect(normaliseExerciseName('Pull‑Up — Max Reps')).toBe('pull up max reps');
  });

  it('gives the same id on every device for the same exercise', async () => {
    expect(await exerciseIdFor('Bench Press (Barbell)')).toBe(await exerciseIdFor('bench press barbell'));
    expect(await exerciseIdFor('Bench Press (Barbell)')).not.toBe(await exerciseIdFor('Bench Press (Dumbbell)'));
  });
});

describe('derivePosition', () => {
  const blocks: Block[] = [
    { id: 'b1', name: 'Base', weeks: 2, dayIds: ['mon', 'wed', 'fri'] },
    { id: 'b2', name: 'Peak', weeks: 1, dayIds: ['mon2', 'thu2'] },
  ];

  it('starts at week 1 day 1 with nothing done', () => {
    expect(derivePosition(blocks, [])).toEqual({ week: 1, dayIdx: 0, doneDayIds: [], finished: false });
  });

  it('serves the first undone day of the current week, even out of order', () => {
    expect(derivePosition(blocks, [{ week: 1, dayId: 'wed' }])).toMatchObject({ week: 1, dayIdx: 0, doneDayIds: ['wed'] });
  });

  it('moves to the next week only when every day is done', () => {
    const done = ['mon', 'wed', 'fri'].map((dayId) => ({ week: 1, dayId }));
    expect(derivePosition(blocks, done)).toMatchObject({ week: 2, dayIdx: 0, doneDayIds: [] });
  });

  it('crosses into the next block', () => {
    const done = [1, 2].flatMap((week) => ['mon', 'wed', 'fri'].map((dayId) => ({ week, dayId })));
    expect(derivePosition(blocks, done)).toMatchObject({ week: 3, dayIdx: 0 });
  });

  it('ignores duplicates from two devices (no double-advance)', () => {
    const done = [
      { week: 1, dayId: 'mon' },
      { week: 1, dayId: 'mon' },
    ];
    expect(derivePosition(blocks, done)).toMatchObject({ week: 1, dayIdx: 1, doneDayIds: ['mon'] });
  });

  it('reports finished after the last day of the last week', () => {
    const done = [
      ...[1, 2].flatMap((week) => ['mon', 'wed', 'fri'].map((dayId) => ({ week, dayId }))),
      { week: 3, dayId: 'mon2' },
      { week: 3, dayId: 'thu2' },
    ];
    expect(derivePosition(blocks, done)).toMatchObject({ finished: true });
  });
});
