import { useLiveQuery } from 'dexie-react-hooks';
import { db, getPlateSetup, lastTime, positionOf } from '../../db/repo';
import type { PlannedExercise, SetLog } from '../../db/schema';
import { formatWeight, suggestionLine } from '../../engine/copy';
import { platesFor } from '../../engine/plates';
import { DEFAULT_BAR, loadStep } from '../../engine/rounding';
import { blockForWeek, isDeloadWeek } from '../../engine/schedule';
import type { Units } from '../../engine/types';
import { Sheet } from '../../ui/Sheet';

export type Group = { plan: PlannedExercise; logs: SetLog[] };

export const EQUIPMENT: { value: PlannedExercise['loadType']; label: string }[] = [
  { value: 'barbell', label: 'Barbell' },
  { value: 'dumbbell', label: 'Dumbbell' },
  { value: 'machine', label: 'Machine (stack)' },
  { value: 'plates', label: 'Plate-loaded' },
  { value: 'bodyweight', label: 'Bodyweight' },
];
export const equipmentLabel = (t: PlannedExercise['loadType']) => EQUIPMENT.find((e) => e.value === t)?.label ?? t;

export const repRange = (p: { repMin: number; repMax: number }) =>
  p.repMin === p.repMax ? `${p.repMin}` : `${p.repMin}–${p.repMax}`;

export const fmtLoad = (kg: number | null, bw: boolean) =>
  bw ? (kg ? `BW+${formatWeight(kg)}` : 'BW') : kg != null ? formatWeight(kg) : '—';

export const setLabel = (l: SetLog, working: SetLog[]) =>
  l.setType === 'warmup' ? 'Warm-up' : `Set ${working.indexOf(l) + 1} of ${working.length}`;

/** "RPE 8" or "RPE 6–8"; empty when the programme sets no RPE. */
export const rpeText = (p: { targetRpe: number | null; targetRpeMin?: number | null }) =>
  p.targetRpe == null ? '' : p.targetRpeMin != null && p.targetRpeMin < p.targetRpe ? `RPE ${p.targetRpeMin}–${p.targetRpe}` : `RPE ${p.targetRpe}`;

export const isAmrapPlan = (p: PlannedExercise) => /amrap/i.test(p.setTypeLabel ?? '');

/** Short badge for a special set type from the programme (labels only for now). */
export function setTypeBadge(p: PlannedExercise): string | null {
  const t = (p.setTypeLabel ?? '').toLowerCase();
  if (!t) return null;
  if (t.includes('amrap')) return 'AMRAP last set';
  if (t.includes('drop')) return 'Drop set';
  if (t.includes('rest-pause') || t.includes('rest pause')) return 'Rest-pause';
  if (t.includes('super') || /^[a-z]d$/.test(t)) return 'Superset';
  return p.setTypeLabel ?? null;
}

/** The programme's note for this exercise: one line, tap to read it all. */
export function ExerciseNotes({ cue }: { cue?: string | null }) {
  if (!cue) return null;
  return (
    <details className="ex-notes">
      <summary>{cue}</summary>
      <p>{cue}</p>
    </details>
  );
}

/** First-time stepper starts at the bar, 10 kg dumbbells, or one machine step. */
export const startingWeight = (loadType: PlannedExercise['loadType'], units: Units) =>
  loadType === 'barbell'
    ? DEFAULT_BAR[units]
    : loadType === 'dumbbell'
      ? units === 'kg'
        ? 10
        : 25
      : loadStep({ loadType }, units);

/** Suggestion line, rendered inside the set card. Tap → "why" sheet. */
export function SuggestionRow({ plan, units, onWhy }: { plan: PlannedExercise; units: Units; onWhy: () => void }) {
  const last = useLiveQuery(() => lastTime(plan.exerciseId), [plan.exerciseId]);
  let glyph = '=';
  let text: string;
  if (plan.outcome === 'deload') {
    glyph = '↓';
    text = '60% · one set fewer · should feel easy';
  } else if (plan.outcome === 'programme') {
    text = `${plan.suggestedKg != null ? `${formatWeight(plan.suggestedKg)} ${units}` : 'Programme'} · from your programme`;
  } else if (plan.outcome === 'imported') {
    text = `${formatWeight(plan.suggestedKg ?? 0)} ${units} · from your imported history`;
  } else {
    const line = suggestionLine(
      {
        outcome: plan.outcome as 'increase',
        weight: plan.suggestedKg,
        repTargets: plan.repTargets,
        focusSet: plan.focusSet,
        basedOnWeight: plan.basedOnWeight ?? null,
        reason: plan.reason,
      },
      units,
      last ?? null,
    );
    glyph = line.glyph;
    text = line.text;
  }
  return (
    <button className="suggestion" onClick={onWhy} aria-label={`${text}. Why this weight?`}>
      <span className="glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{text}</span>
      <span className="why">why?</span>
    </button>
  );
}

/** Olympic (IWF) plate colours; lb plates take the colour of the nearest kg plate. */
const KG_COLOURS: [number, string][] = [
  [25, '#d62828'],
  [20, '#1d4ed8'],
  [15, '#eab308'],
  [10, '#16a34a'],
  [5, '#f4f4f5'],
  [2.5, '#b91c1c'],
  [2, '#1d4ed8'],
  [1.25, '#a1a1aa'],
  [1, '#16a34a'],
  [0.5, '#f4f4f5'],
];
export function plateColour(w: number, units: Units): string {
  const kg = units === 'lb' ? w / 2.2046226218 : w;
  return KG_COLOURS.reduce((best, c) => (Math.abs(c[0] - kg) < Math.abs(best[0] - kg) ? c : best))[1];
}
/** Bigger plates are taller and thicker, like the real thing. */
function plateShape(w: number, units: Units) {
  const kg = units === 'lb' ? w / 2.2046226218 : w;
  const h = kg >= 15 ? 56 : kg >= 10 ? 48 : kg >= 5 ? 38 : kg >= 2 ? 30 : 24;
  const t = kg >= 20 ? 11 : kg >= 10 ? 9 : kg >= 5 ? 7 : 5;
  return { h, t };
}

/**
 * Visual plate calculator: one side of the bar from the collar outwards,
 * in Olympic colours, using only the plates set in ME → Plates & bar.
 */
export function Plates({ kg, units, noBar = false }: { kg: number; units: Units; noBar?: boolean }) {
  const setup = useLiveQuery(() => getPlateSetup(units), [units]);
  if (!setup) return null;
  const bar = noBar ? 0 : setup.bar;
  const p = platesFor(kg, units, bar, setup.plates);
  const shapes = p.perSide.map((w) => ({ w, ...plateShape(w, units) }));
  const width = 28 + shapes.reduce((x, s) => x + s.t + 2, 0) + 26;
  const empty = noBar ? 'no plates' : `empty bar (${formatWeight(setup.bar)} ${units})`;
  const label = p.perSide.length ? `Per side: ${p.perSide.join(', ')} ${units}` : noBar ? 'No plates' : 'Empty bar';
  let x = 28;
  return (
    <figure className="plate-bar" aria-label={`${label}${p.exact ? '' : `, makes ${formatWeight(p.achieved)}`}`}>
      <svg viewBox={`0 0 ${width} 64`} width={width} height={64} aria-hidden="true">
        <rect x="0" y="29" width={width} height="6" rx="3" className="bar-sleeve" />
        <rect x="22" y="20" width="6" height="24" rx="2" className="bar-collar" />
        {shapes.map((s, i) => {
          const r = <rect key={i} x={x} y={32 - s.h / 2} width={s.t} height={s.h} rx="2" fill={plateColour(s.w, units)} className="plate-rect" />;
          x += s.t + 2;
          return r;
        })}
      </svg>
      <figcaption>
        {p.perSide.length ? (
          <>
            {p.perSide.map((w, i) => (
              <span key={i} className="plate-tag" style={{ borderColor: plateColour(w, units) }}>
                {formatWeight(w)}
              </span>
            ))}
            <span className="per">per side</span>
          </>
        ) : (
          <span className="per">{empty}</span>
        )}
        {!p.exact && <span className="per">· can't make it exactly, closest {formatWeight(p.achieved)}</span>}
      </figcaption>
    </figure>
  );
}

export function WhySheet({
  plan,
  units,
  onClose,
  onChange,
}: {
  plan: PlannedExercise;
  units: Units;
  onClose: () => void;
  onChange: () => void;
}) {
  const last = useLiveQuery(() => lastTime(plan.exerciseId), [plan.exerciseId]);
  return (
    <Sheet label="Why this weight" onClose={onClose}>
      <h2>Why this weight</h2>
      <p>{plan.reason}</p>
      <p className="muted">
        {last
          ? `Last time: ${last.kg != null ? `${formatWeight(last.kg)} ${units}` : 'bodyweight'} × ${last.reps}${last.rpe ? ` @${last.rpe}` : ''}`
          : 'No history for this exercise yet.'}
        {' · '}Target {plan.sets} × {repRange(plan)}
        {plan.targetRpe ? ` @ RPE ${plan.targetRpe}` : ''}
      </p>
      <button className="btn-secondary" onClick={onChange}>
        Change today's weight
      </button>
    </Sheet>
  );
}

/**
 * Every set of the WHOLE workout (edit an exercise after moving on).
 * Tap a done set to edit it (weight, reps, RPE); tap a pending one to make it the active set.
 */
export function SetListSheet({
  groups,
  currentId,
  activeId,
  units,
  onPick,
  onClose,
}: {
  groups: Group[];
  /** dayExerciseId of the exercise on screen, marked "now". */
  currentId: string;
  activeId: string | null;
  units: Units;
  onPick: (log: SetLog) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label="All sets in this workout" onClose={onClose}>
      <h2>All sets</h2>
      {groups.map((g) => {
        const bw = g.plan.loadType === 'bodyweight';
        const working = g.logs.filter((l) => l.setType === 'straight');
        const current = g.plan.dayExerciseId === currentId;
        return (
          <section key={g.plan.dayExerciseId} className={`set-group ${current ? 'current' : ''}`} aria-label={g.plan.name}>
            <h3>
              {g.plan.name}
              {current && <span className="side"> · now</span>}
            </h3>
            <ul className="sheet-list">
              {g.logs.map((l) => {
                const isActive = l.id === activeId;
                return (
                  <li key={l.id}>
                    <button
                      onClick={() => onPick(l)}
                      aria-label={`${g.plan.name}, ${setLabel(l, working)}: ${fmtLoad(l.kg, bw)} ${bw ? '' : units} for ${l.reps} reps${l.completed ? ', done. Edit' : ''}`}
                    >
                      <span className={l.completed ? 'mark' : isActive ? 'mark now' : 'mark muted'}>
                        {l.completed ? '✓' : isActive ? '▸' : l.setType === 'warmup' ? 'W' : working.indexOf(l) + 1}
                      </span>
                      <span className={isActive ? 'now' : undefined}>
                        {l.setType === 'warmup' ? 'Warm-up' : `Set ${working.indexOf(l) + 1}`} · {fmtLoad(l.kg, bw)} × {l.reps}
                        {l.rpe ? ` · RPE ${l.rpe}` : ''}
                      </span>
                      <span className="side">{isActive ? 'now' : l.completed ? 'edit' : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </Sheet>
  );
}

/** Today + this week + next deload. Used as a sheet on phones and as the ≥768px side panel. */
export function ProgrammeContent({
  groups,
  session,
  onJump,
}: {
  groups: Group[];
  session: { athleteProgrammeId: string; week: number; dayId: string };
  onJump: (logId: string) => void;
}) {
  const week = useLiveQuery(async () => {
    const ap = await db().athleteProgrammes.get(session.athleteProgrammeId);
    if (!ap) return null;
    const programme = await db().programmes.get(ap.programmeId);
    const { blocks, pos: derived } = await positionOf(ap);
    const pos = blockForWeek(blocks, session.week);
    const doneDayIds = derived.week === session.week ? derived.doneDayIds : [];
    const days = pos ? await db().days.bulkGet(pos.block.dayIds) : [];
    const every = programme?.deloadEvery ?? 4;
    let nextDeload: number | null = null;
    for (let w = session.week; every > 0 && w <= session.week + every; w++) {
      if (isDeloadWeek(w, ap.deloadAnchorWeek, every)) {
        nextDeload = w;
        break;
      }
    }
    return { ap, doneDayIds, block: pos?.block.name, days: days.filter((d) => d != null), nextDeload };
  }, [session.athleteProgrammeId, session.week]);

  return (
    <>
      <h2>Today</h2>
      <ul className="sheet-list">
        {groups.map((g) => {
          const allDone = g.logs.every((l) => l.completed);
          const firstOpen = g.logs.find((l) => !l.completed);
          return (
            <li key={g.plan.dayExerciseId}>
              <button disabled={allDone} onClick={() => firstOpen && onJump(firstOpen.id)}>
                <span className="mark" aria-label={allDone ? 'done' : undefined}>
                  {allDone ? '✓' : ''}
                </span>
                <span>{g.plan.name}</span>
                <span className="side">
                  {g.plan.sets}×{repRange(g.plan)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {week && (
        <>
          <h2 style={{ marginTop: 24 }}>
            Week {session.week}
            {week.block ? ` · ${week.block}` : ''}
          </h2>
          <ul className="sheet-list">
            {week.days.map((d) => (
              <li key={d.id}>
                <span className="item">
                  <span className="mark">{week.doneDayIds.includes(d.id) ? '✓' : ''}</span>
                  <span>{d.name}</span>
                  {d.id === session.dayId && <span className="side">today</span>}
                </span>
              </li>
            ))}
          </ul>
          {week.nextDeload != null && (
            <p className="muted" style={{ marginTop: 12 }}>
              {week.nextDeload === session.week ? 'This is a deload week.' : `Next deload: week ${week.nextDeload}`}
            </p>
          )}
        </>
      )}
    </>
  );
}
