import type { ImportedProgramme } from '../db/repo';

/** Built-in starter (the "no programme" state). Generic, no personal data. */
export const STARTER: ImportedProgramme = {
  name: 'Retro Starter · Full Body 3×',
  deloadEvery: 4,
  blocks: [
    {
      name: 'Foundation',
      weeks: 8,
      days: [
        {
          name: 'Day A · Squat + Bench',
          exercises: [
            { name: 'Squat (Barbell)', loadType: 'barbell', restSec: 150, sets: 3, repMin: 5, repMax: 8, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Bench Press (Barbell)', loadType: 'barbell', restSec: 150, sets: 3, repMin: 5, repMax: 8, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Seated Cable Row', loadType: 'machine', restSec: 90, sets: 3, repMin: 8, repMax: 12, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Plank', loadType: 'bodyweight', restSec: 60, sets: 2, repMin: 30, repMax: 60, targetRpe: null, prescribedKg: null, warmups: [] },
          ],
        },
        {
          name: 'Day B · Deadlift + Press',
          exercises: [
            { name: 'Deadlift (Barbell)', loadType: 'barbell', restSec: 180, sets: 3, repMin: 4, repMax: 6, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Overhead Press (Barbell)', loadType: 'barbell', restSec: 120, sets: 3, repMin: 6, repMax: 8, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Lat Pulldown', loadType: 'machine', restSec: 90, sets: 3, repMin: 8, repMax: 12, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Walking Lunge (Dumbbell)', loadType: 'dumbbell', restSec: 90, sets: 2, repMin: 10, repMax: 12, targetRpe: 8, prescribedKg: null, warmups: [] },
          ],
        },
        {
          name: 'Day C · Volume',
          exercises: [
            { name: 'Romanian Deadlift (Barbell)', loadType: 'barbell', restSec: 120, sets: 3, repMin: 8, repMax: 10, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Incline Press (Dumbbell)', loadType: 'dumbbell', restSec: 90, sets: 3, repMin: 8, repMax: 12, targetRpe: 8, prescribedKg: null, warmups: [] },
            { name: 'Pull-Up', loadType: 'bodyweight', restSec: 120, sets: 3, repMin: 5, repMax: 10, targetRpe: null, prescribedKg: null, warmups: [] },
            { name: 'Leg Press', loadType: 'machine', restSec: 90, sets: 3, repMin: 10, repMax: 15, targetRpe: 8, prescribedKg: null, warmups: [] },
          ],
        },
      ],
    },
  ],
};
