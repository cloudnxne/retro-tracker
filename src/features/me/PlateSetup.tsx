import { useLiveQuery } from 'dexie-react-hooks';
import { getPlateSetup, getUnits, setPlateSetup } from '../../db/repo';
import { formatWeight } from '../../engine/copy';
import { BAR_CHOICES, PLATE_CHOICES } from '../../engine/rounding';
import { safeWrite } from '../../lib/safeWrite';
import { plateColour } from '../session/SessionParts';

/** "20 kg bar · 7 plates" for the ME row. */
export function usePlateSummary(): string | null {
  return (
    useLiveQuery(async () => {
      const units = await getUnits();
      const s = await getPlateSetup(units);
      return `${formatWeight(s.bar)} ${units} bar · ${s.plates.length} plate sizes`;
    }, []) ?? null
  );
}

/**
 * ME → Plates & bar: which plates this gym has, and the bar. Suggested
 * weights and the plate calculator only use these. At least one plate size stays on.
 */
export function PlateSetup() {
  const data = useLiveQuery(async () => {
    const units = await getUnits();
    return { units, setup: await getPlateSetup(units) };
  }, []);
  if (!data) return null;
  const { units, setup } = data;
  const save = (next: { plates: number[]; bar: number }) => void safeWrite('Plates & bar', () => setPlateSetup(units, next));
  const toggle = (p: number) => {
    const on = setup.plates.includes(p);
    if (on && setup.plates.length === 1) return; // keep at least one
    save({ ...setup, plates: on ? setup.plates.filter((x) => x !== p) : [...setup.plates, p] });
  };

  return (
    <>
      <h2>Plates & bar</h2>
      <p className="muted">Pick what your gym has. Suggested weights and the plate picture only use these.</p>
      <div className="fuel-field">
        <span>Bar</span>
        <div className="seg" role="group" aria-label="Bar weight">
          {BAR_CHOICES[units].map((b) => (
            <button key={b} aria-pressed={setup.bar === b} onClick={() => save({ ...setup, bar: b })}>
              {formatWeight(b)} {units}
            </button>
          ))}
        </div>
      </div>
      <div className="fuel-field">
        <span>Plates (pairs)</span>
        <div className="plate-choices" role="group" aria-label="Plates you have">
          {PLATE_CHOICES[units].map((p) => {
            const on = setup.plates.includes(p);
            return (
              <button
                key={p}
                className="plate-choice"
                aria-pressed={on}
                aria-label={`${formatWeight(p)} ${units} plates${on && setup.plates.length === 1 ? ' (at least one size stays on)' : ''}`}
                style={{ borderColor: plateColour(p, units) }}
                onClick={() => toggle(p)}
              >
                {formatWeight(p)}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
