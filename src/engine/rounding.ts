import type { ExerciseLoad, Units } from './types';

/** A full plate set (the default). */
export const PLATES: Record<Units, number[]> = {
  kg: [25, 20, 15, 10, 5, 2.5, 1.25],
  lb: [45, 35, 25, 10, 5, 2.5],
};
/** Every size a lifter can switch on in ME → Plates & bar (fractional plates included). */
export const PLATE_CHOICES: Record<Units, number[]> = {
  kg: [25, 20, 15, 10, 5, 2.5, 2, 1.25, 1, 0.5],
  lb: [55, 45, 35, 25, 10, 5, 2.5, 1.25],
};
export const BAR_CHOICES: Record<Units, number[]> = { kg: [20, 15, 10], lb: [45, 35, 25] };

export const DEFAULT_BAR: Record<Units, number> = { kg: 20, lb: 45 };
const DUMBBELL_STEP: Record<Units, number> = { kg: 2, lb: 5 };
const DEFAULT_MACHINE_STEP: Record<Units, number> = { kg: 5, lb: 10 };

/** Smallest change in total load the equipment allows. */
export function loadStep(load: ExerciseLoad, units: Units): number {
  switch (load.loadType) {
    case 'barbell':
    case 'plates':
      return Math.min(...(load.plates?.length ? load.plates : PLATES[units])) * 2;
    case 'dumbbell':
      return DUMBBELL_STEP[units];
    case 'machine':
      return load.loadIncrement ?? DEFAULT_MACHINE_STEP[units];
    case 'bodyweight':
      return 0;
  }
}

/** Increase applied when every set hit the top of the range (plan: progression table row 3). */
export function increaseStep(load: ExerciseLoad, units: Units): number {
  switch (load.loadType) {
    case 'barbell':
      // Never below what the plates can actually add: without 1.25 kg plates the smallest jump is 5 kg,
      // and a +2.5 would round straight back down (the lift could never progress).
      return Math.max(units === 'kg' ? 2.5 : 5, loadStep(load, units));
    case 'dumbbell':
      return units === 'kg' ? 2 : 5;
    // Plate-loaded machines: a plate each side is the usual jump (5 kg / 10 lb), never less than the plates allow.
    case 'plates':
      return Math.max(units === 'kg' ? 5 : 10, loadStep(load, units));
    // The plan says "+2 kg" for machines, but a 5 kg stack can't load +2,
    // so a machine always moves one stack step.
    case 'machine':
      return loadStep(load, units);
    case 'bodyweight':
      return 0;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Round DOWN to the nearest weight the equipment can actually load. */
export function roundDownLoadable(weight: number, load: ExerciseLoad, units: Units): number {
  if (load.loadType === 'bodyweight') return weight;
  const step = loadStep(load, units);
  if (load.loadType === 'barbell' || load.loadType === 'plates') {
    const bar = load.loadType === 'plates' ? 0 : (load.barWeight ?? DEFAULT_BAR[units]);
    if (weight <= bar) return bar;
    return round2(bar + Math.floor(round2((weight - bar) / step)) * step);
  }
  if (weight <= step) return step;
  return round2(Math.floor(round2(weight / step)) * step);
}
