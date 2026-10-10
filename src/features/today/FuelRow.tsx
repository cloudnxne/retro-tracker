import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { bodyweightOn, fuelOn, getUnits, proteinTargetOn, saveBodyweight, saveFuel } from '../../db/repo';
import type { FoodLevel, ProteinLevel } from '../../db/schema';
import { formatWeight } from '../../engine/copy';
import { addDays, dateKey, dayLabel, defaultFuelDate } from '../../lib/fuelDay';
import { safeWrite } from '../../lib/safeWrite';
import { Sheet } from '../../ui/Sheet';
import { NumberInput } from '../../ui/NumberInput';

/**
 * FUEL check-in (guesses, 1.6 g/kg, collapsed row above Start).
 *   collapsed line ─tap─▶ sheet: day ▾ · protein Under/Hit/Well over · food Light/Normal/Big · morning weight
 * Three taps on a normal morning. Food is filed under the day it was eaten.
 */
const PROTEIN: { value: ProteinLevel; label: string }[] = [
  { value: 'under', label: 'Under' },
  { value: 'hit', label: 'Hit' },
  { value: 'over', label: 'Well over' },
];
const FOOD: { value: FoodLevel; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'normal', label: 'Normal' },
  { value: 'big', label: 'Big' },
];
const PROTEIN_WORD: Record<ProteinLevel, string> = { under: 'protein under', hit: 'protein hit', over: 'protein well over' };
const FOOD_WORD: Record<FoodLevel, string> = { light: 'light day', normal: 'normal day', big: 'big day' };

export function FuelRow() {
  const [open, setOpen] = useState(false);
  const now = new Date();
  const day = defaultFuelDate(now);
  const today = dateKey(now);
  const summary = useLiveQuery(async () => {
    const { food } = await fuelOn(day);
    const weight = (await fuelOn(today)).bodyweight;
    return { food, weight, units: await getUnits() };
  }, [day, today]);

  const parts: string[] = [];
  if (summary?.food?.proteinLevel) parts.push(PROTEIN_WORD[summary.food.proteinLevel]);
  if (summary?.food?.foodLevel) parts.push(FOOD_WORD[summary.food.foodLevel]);
  if (summary?.weight != null) parts.push(`${formatWeight(summary.weight)} ${summary.units}`);
  const done = parts.length > 0;

  return (
    <>
      <button className="fuel-row" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="fuel-tag">FUEL</span>
        <span className="fuel-text">
          {done ? `${dayLabel(day, now)}: ${parts.join(' · ')}` : `Log ${dayLabel(day, now).toLowerCase()}'s food · 10 s`}
        </span>
        <span aria-hidden="true">{done ? '✓' : '›'}</span>
      </button>
      {open && <FuelSheet initialDay={day} onClose={() => setOpen(false)} />}
    </>
  );
}

function FuelSheet({ initialDay, onClose }: { initialDay: string; onClose: () => void }) {
  const now = new Date();
  const today = dateKey(now);
  const [day, setDay] = useState(initialDay);
  const [protein, setProtein] = useState<ProteinLevel | null | undefined>(undefined);
  const [food, setFood] = useState<FoodLevel | null | undefined>(undefined);
  const [weight, setWeight] = useState<number | null | undefined>(undefined);
  const [typedW, setTypedW] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    const units = await getUnits();
    return {
      units,
      saved: (await fuelOn(day)).food,
      target: await proteinTargetOn(day),
      lastWeight: await bodyweightOn(today),
      todayWeight: (await fuelOn(today)).bodyweight,
    };
  }, [day, today]);
  if (!data) return null;

  // Unsaved taps win; otherwise show what's stored for that day.
  const p = protein !== undefined ? protein : (data.saved?.proteinLevel ?? null);
  const f = food !== undefined ? food : (data.saved?.foodLevel ?? null);
  const startWeight = data.todayWeight ?? data.lastWeight ?? (data.units === 'lb' ? 175 : 80);
  const typedNum = typedW != null && typedW !== '' ? Number(typedW) : null;
  const w = typedNum ?? (weight !== undefined ? weight : data.todayWeight);
  const badWeight = typedNum != null && (typedNum < (data.units === 'lb' ? 45 : 20) || typedNum > (data.units === 'lb' ? 880 : 400));
  const step = data.units === 'lb' ? 0.2 : 0.1;
  const nudge = (d: number) => {
    setTypedW(null);
    setWeight(Math.round(((w ?? startWeight) + d) * 10) / 10);
  };
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, -i));

  const save = async () => {
    const ok = await safeWrite('Saving FUEL', async () => {
      if (protein !== undefined || food !== undefined) await saveFuel(day, { proteinLevel: p, foodLevel: f });
      if ((typedNum ?? weight) != null) await saveBodyweight(today, (typedNum ?? weight)!);
    });
    if (ok) onClose();
  };

  return (
    <Sheet label="FUEL check-in" onClose={onClose}>
      <h2>FUEL</h2>
      <label className="fuel-day">
        <span className="muted">Food eaten on</span>
        <select value={day} onChange={(e) => (setDay(e.target.value), setProtein(undefined), setFood(undefined))}>
          {days.map((k) => (
            <option key={k} value={k}>
              {dayLabel(k, now)}
            </option>
          ))}
        </select>
      </label>

      <div className="fuel-field">
        <span>Protein</span>
        <span className="muted">
          {data.target.grams != null
            ? `Target ≈ ${data.target.grams} g (${data.target.gPerKg} g/kg)`
            : 'Log your bodyweight once to set a target'}
        </span>
        <div className="seg" role="group" aria-label="Protein against your target">
          {PROTEIN.map((o) => (
            <button key={o.value} aria-pressed={p === o.value} onClick={() => setProtein(p === o.value ? null : o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="fuel-field">
        <span>Food overall</span>
        <div className="seg" role="group" aria-label="Food overall">
          {FOOD.map((o) => (
            <button key={o.value} aria-pressed={f === o.value} onClick={() => setFood(f === o.value ? null : o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="fuel-field">
        <span>Bodyweight this morning</span>
        <div className="fuel-weight">
          <button className="btn-secondary" aria-label={`Decrease by ${step}`} onClick={() => nudge(-step)}>
            −
          </button>
          <div className="stepper-value">
            <NumberInput
              label={`Bodyweight this morning, ${data.units}`}
              display={w != null ? formatWeight(w) : ''}
              typed={typedW}
              onType={setTypedW}
              onEnter={() => !badWeight && void save()}
            />
            <small className="muted">{data.units}</small>
          </div>
          <button className="btn-secondary" aria-label={`Increase by ${step}`} onClick={() => nudge(step)}>
            +
          </button>
        </div>
        {badWeight && (
          <p role="alert" style={{ color: 'var(--warn)' }}>
            That doesn't look like a bodyweight. Check the number.
          </p>
        )}
        {w == null && typedW == null && (
          <button className="btn-link" onClick={() => setWeight(startWeight)}>
            Same as last time
          </button>
        )}
      </div>

      <div className="sheet-actions">
        <button className="btn-secondary" onClick={onClose}>
          CANCEL
        </button>
        <button className="btn-primary" disabled={badWeight} onClick={() => void save()}>
          SAVE
        </button>
      </div>
    </Sheet>
  );
}
