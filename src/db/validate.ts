import type { LoadType } from '../engine/types';

/**
 * Programme files come from the PHP migration now and from PTs later.
 * Validate at the boundary so a bad file fails with a named error instead of producing
 * NaN weights at the gym. Hand-written on purpose: no schema library for ~40 lines of rules.
 */

export interface ImportedExercise {
  name: string;
  loadType: LoadType;
  restSec: number;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  /** Bottom of an RPE range ("RPE 6–8" → targetRpeMin 6, targetRpe 8). */
  targetRpeMin?: number | null;
  prescribedKg: number | null;
  progression?: 'auto' | 'prescribed';
  warmups: { kg: number | null; reps: number }[];
  cue?: string | null;
  sourceSetType?: string | null;
}

export interface ImportedProgramme {
  name: string;
  athleteName?: string;
  deloadEvery?: number;
  blocks: { name: string; weeks: number; days: { name: string; exercises: ImportedExercise[] }[] }[];
}

const LOAD_TYPES: LoadType[] = ['barbell', 'dumbbell', 'machine', 'plates', 'bodyweight'];

export class ProgrammeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function validateProgramme(input: unknown): ImportedProgramme {
  const fail = (path: string, msg: string): never => {
    throw new ProgrammeError(path ? `${path}: ${msg}` : msg);
  };
  if (!isObj(input)) fail('', 'Not a programme file.');
  const p = input as Record<string, unknown>;
  if (!nonEmpty(p.name)) fail('', 'Programme needs a name.');
  if (p.deloadEvery !== undefined && !(isInt(p.deloadEvery) && (p.deloadEvery as number) >= 0 && (p.deloadEvery as number) <= 52)) {
    fail('', 'deloadEvery must be a whole number from 0 to 52.');
  }
  if (!Array.isArray(p.blocks) || !p.blocks.length) fail('', 'Programme needs at least one block.');

  (p.blocks as unknown[]).forEach((b, bi) => {
    const bp = `Block ${bi + 1}`;
    if (!isObj(b)) fail(bp, 'is not a block.');
    const block = b as Record<string, unknown>;
    if (!nonEmpty(block.name)) fail(bp, 'needs a name.');
    if (!(isInt(block.weeks) && (block.weeks as number) >= 1 && (block.weeks as number) <= 52)) fail(bp, 'weeks must be 1–52.');
    if (!Array.isArray(block.days) || !block.days.length) fail(bp, 'needs at least one day.');

    (block.days as unknown[]).forEach((d, di) => {
      const dp = `${bp} › Day ${di + 1}`;
      if (!isObj(d)) fail(dp, 'is not a day.');
      const day = d as Record<string, unknown>;
      if (!nonEmpty(day.name)) fail(dp, 'needs a name.');
      const dayPath = `${bp} › Day "${day.name}"`;
      if (!Array.isArray(day.exercises)) fail(dayPath, 'needs an exercises list.');

      (day.exercises as unknown[]).forEach((e, ei) => {
        if (!isObj(e)) fail(`${dayPath} › Exercise ${ei + 1}`, 'is not an exercise.');
        const ex = e as Record<string, unknown>;
        const ep = `${dayPath} › ${nonEmpty(ex.name) ? ex.name : `Exercise ${ei + 1}`}`;
        if (!nonEmpty(ex.name)) fail(ep, 'needs a name.');
        if (!LOAD_TYPES.includes(ex.loadType as LoadType)) fail(ep, `loadType must be one of ${LOAD_TYPES.join(', ')}.`);
        if (!(isInt(ex.sets) && (ex.sets as number) >= 1 && (ex.sets as number) <= 20)) fail(ep, 'sets must be a whole number 1–20.');
        if (!(isInt(ex.repMin) && (ex.repMin as number) >= 1)) fail(ep, 'repMin must be a whole number ≥ 1.');
        if (!(isInt(ex.repMax) && (ex.repMax as number) <= 100)) fail(ep, 'repMax must be a whole number ≤ 100.');
        if ((ex.repMin as number) > (ex.repMax as number)) fail(ep, 'repMin > repMax.');
        if (!(ex.targetRpe === null || (isNum(ex.targetRpe) && (ex.targetRpe as number) >= 5 && (ex.targetRpe as number) <= 10))) {
          fail(ep, 'targetRpe must be empty or 5–10.');
        }
        if (ex.targetRpeMin != null && !(isNum(ex.targetRpeMin) && (ex.targetRpeMin as number) >= 5 && ex.targetRpe != null && (ex.targetRpeMin as number) <= (ex.targetRpe as number))) {
          fail(ep, 'targetRpeMin must be 5–10 and no higher than targetRpe.');
        }
        if (!(isInt(ex.restSec) && (ex.restSec as number) >= 0 && (ex.restSec as number) <= 900)) fail(ep, 'restSec must be 0–900.');
        if (!(ex.prescribedKg === null || (isNum(ex.prescribedKg) && (ex.prescribedKg as number) >= 0))) fail(ep, 'prescribedKg must be empty or ≥ 0.');
        if (ex.progression !== undefined && ex.progression !== 'auto' && ex.progression !== 'prescribed') {
          fail(ep, 'progression must be "auto" or "prescribed".');
        }
        if (!Array.isArray(ex.warmups)) fail(ep, 'warmups must be a list (can be empty).');
        (ex.warmups as unknown[]).forEach((w, wi) => {
          const wp = `${ep} › warm-up ${wi + 1}`;
          if (!isObj(w)) fail(wp, 'is not a warm-up.');
          const wu = w as Record<string, unknown>;
          if (!(wu.kg === null || (isNum(wu.kg) && (wu.kg as number) >= 0))) fail(wp, 'kg must be empty or ≥ 0.');
          if (!(isInt(wu.reps) && (wu.reps as number) >= 1)) fail(wp, 'reps must be a whole number ≥ 1.');
        });
      });
    });
  });
  return input as ImportedProgramme;
}
