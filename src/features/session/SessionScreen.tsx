import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  confirmSet,
  db,
  discardSession,
  editSet,
  finishSession,
  setExerciseLoadType,
  getSetting,
  getUnits,
  STALE_SESSION_MS,
  undoSet,
  type SessionSummary,
} from '../../db/repo';
import type { SetLog } from '../../db/schema';
import { formatWeight } from '../../engine/copy';
import { loadStep } from '../../engine/rounding';
import { EditSheet } from '../../ui/EditSheet';
import { Sheet } from '../../ui/Sheet';
import { SyncBadge } from '../../ui/SyncBadge';
import { fmtClock, useRestTimer } from '../../lib/useRestTimer';
import { useWakeLock } from '../../lib/wakeLock';
import { buzz, setDoneSound, unlockAudio } from '../../lib/sound';
import { safeWrite } from '../../lib/safeWrite';
import {
  EQUIPMENT,
  equipmentLabel,
  ExerciseNotes,
  fmtLoad,
  isAmrapPlan,
  Plates,
  rpeText,
  setTypeBadge,
  ProgrammeContent,
  repRange,
  setLabel,
  SetListSheet,
  startingWeight,
  SuggestionRow,
  WhySheet,
  type Group,
} from './SessionParts';
import { SunMark } from '../../ui/SunMark';

const RPE_VALUES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

type Editing = { log: SetLog; field: 'kg' | 'reps' } | null;
type SheetName = 'programme' | 'menu' | 'why' | 'end' | 'row' | 'sets' | 'keys' | 'equipment' | null;

export function SessionScreen({ sessionId, onFinished }: { sessionId: string; onFinished: (s: SessionSummary) => void }) {
  const session = useLiveQuery(() => db().sessions.get(sessionId), [sessionId]);
  const logs = useLiveQuery(() => db().setLogs.where('sessionId').equals(sessionId).toArray(), [sessionId]);
  const units = useLiveQuery(getUnits, []) ?? 'kg';
  const day = useLiveQuery(async () => (session ? db().days.get(session.dayId) : undefined), [session?.dayId]);
  const liveExercises = useLiveQuery(
    async () => (session ? db().exercises.bulkGet(session.planSnapshot.map((p) => p.exerciseId)) : []),
    [session?.id],
  );
  const timer = useRestTimer(sessionId);
  const soundOn = useLiveQuery(() => getSetting('soundOn', true), []) ?? true;
  // Keyboard shortcuts only make sense with a keyboard (hide them on the phone).
  const touchOnly =
    typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches;
  useWakeLock(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [rpeFor, setRpeFor] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; logId?: string } | null>(null);
  const [pulse, setPulse] = useState(false);
  const [flash, setFlash] = useState(false);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [rowLog, setRowLog] = useState<SetLog | null>(null);
  const [announce, setAnnounce] = useState('');
  const [staleChecked, setStaleChecked] = useState(false);
  const finishing = useRef(false);
  const resumeShown = useRef(false);
  const keyHandler = useRef<((e: KeyboardEvent) => void) | null>(null);

  const groups: Group[] = useMemo(() => {
    if (!session || !logs) return [];
    return session.planSnapshot.map((p) => ({
      plan: p,
      logs: logs.filter((l) => l.dayExerciseId === p.dayExerciseId).sort((a, b) => a.setIndex - b.setIndex),
    }));
  }, [session, logs]);

  const firstOpen = groups.flatMap((g) => g.logs).find((l) => !l.completed) ?? null;
  const active = (selectedId && logs?.find((l) => l.id === selectedId && !l.completed)) || firstOpen;
  const gi = active ? groups.findIndex((g) => g.plan.dayExerciseId === active.dayExerciseId) : -1;
  const group = gi >= 0 ? groups[gi] : groups[groups.length - 1];
  const next = gi >= 0 ? groups.slice(gi + 1).find((g) => g.logs.some((l) => !l.completed)) : undefined;

  // Everything logged → finish automatically.
  useEffect(() => {
    if (!logs?.length || firstOpen || finishing.current) return;
    finishing.current = true;
    void (async () => {
      let summary: SessionSummary | undefined;
      const ok = await safeWrite('Finishing the session', async () => {
        summary = await finishSession(sessionId);
      });
      if (ok && summary) onFinished(summary);
      else finishing.current = false;
    })();
  }, [logs, firstOpen, sessionId, onFinished]);

  // Reopened mid-session (sets already logged) → "Picked up where you left off."
  useEffect(() => {
    if (resumeShown.current || !logs) return;
    resumeShown.current = true;
    if (logs.some((l) => l.completed)) setToast({ text: 'Picked up where you left off.' });
  }, [logs]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (timer.justFinished) setAnnounce('Rest over');
  }, [timer.justFinished]);

  // Keyboard-first on tablet/desktop. The handler is refreshed every render via the ref.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!session || !logs || !group) return <div className="app" aria-busy="true" />;

  // App reopened on a session started more than 6 h ago.
  if (!staleChecked && Date.now() - session.startedAt > STALE_SESSION_MS) {
    const lastSet = Math.max(0, ...logs.map((l) => l.confirmedAt ?? 0));
    const logged = logs.filter((l) => l.completed && l.setType === 'straight').length;
    return (
      <div className="app">
        <main className="frame-screen">
          <div className="sun small" aria-hidden="true" />
          <h1 className="display">Unfinished session</h1>
          <p style={{ margin: '16px 0 8px' }}>
            Started {new Date(session.startedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} ·{' '}
            {logged} sets logged.
          </p>
          <p className="muted" style={{ marginBottom: 24 }}>
            Finish it with what you logged, or discard it?
          </p>
          <div className="stack">
            <button
              className="btn-primary"
              disabled={!logged}
              onClick={async () => {
                finishing.current = true;
                let summary: SessionSummary | undefined;
                const ok = await safeWrite('Finishing the session', async () => {
                  summary = await finishSession(sessionId, lastSet || session.startedAt);
                });
                if (ok && summary) onFinished(summary);
                else finishing.current = false;
              }}
            >
              Finish it
            </button>
            <button className="btn-secondary" onClick={() => setStaleChecked(true)}>
              Keep logging
            </button>
            <button
              className="btn-link"
              onClick={async () => {
                if (!window.confirm('Discard this session? Nothing from it will be saved.')) return;
                await safeWrite('Discarding the session', () => discardSession(sessionId));
              }}
            >
              Discard it
            </button>
          </div>
        </main>
      </div>
    );
  }

  const plan = group.plan;
  // Equipment can be changed mid-session (menu → Equipment), so read it live, not from the snapshot.
  const equipment = liveExercises?.find((e) => e?.id === plan.exerciseId)?.loadType ?? plan.loadType;
  const working = group.logs.filter((l) => l.setType === 'straight');
  const workingNo = active && active.setType === 'straight' ? working.indexOf(active) + 1 : 0;
  const bw = plan.loadType === 'bodyweight';
  const needsWeight = !!active && !bw && active.kg == null;
  const activeHere = !!active && active.dayExerciseId === plan.dayExerciseId;
  const amrapNow = !!active && active.setType === 'straight' && isAmrapPlan(plan) && workingNo === working.length;
  const rpe = rpeText(plan);
  const badge = setTypeBadge(plan);
  /** A set's own exercise: editing from the whole-workout list must use THAT exercise's rules. */
  const groupOf = (l: SetLog) => groups.find((g) => g.plan.dayExerciseId === l.dayExerciseId) ?? group;

  const onDone = async () => {
    if (!active || needsWeight) return;
    unlockAudio();
    const restEndedAt = timer.endsAt && timer.endsAt <= Date.now() ? timer.endsAt : null;
    const label = active.setType === 'warmup' ? 'Warm-up' : `Set ${workingNo}`;
    if (!(await safeWrite(label, () => confirmSet(active, restEndedAt)))) return;
    setSelectedId(null);
    if (soundOn) setDoneSound();
    buzz([35]);
    setPulse(true);
    setFlash(true);
    window.setTimeout(() => setPulse(false), 300);
    window.setTimeout(() => setFlash(false), 650);
    const rest = active.setType === 'warmup' ? Math.min(60, plan.restSec) : plan.restSec;
    await timer.start(rest);
    if (active.setType === 'straight') setRpeFor(active.id);
    setToast({ text: `${label} logged`, logId: active.id });
    setAnnounce(`${label} logged. Rest ${fmtClock(rest * 1000)}.`);
  };

  const onUndo = async () => {
    if (!toast?.logId) return;
    const logId = toast.logId;
    if (!(await safeWrite('Undo', () => undoSet(logId)))) return;
    setSelectedId(toast.logId);
    setToast(null);
    setRpeFor(null);
    await timer.skip();
  };

  const onRpe = async (rpe: number) => {
    const log = logs.find((l) => l.id === rpeFor);
    if (log && !(await safeWrite('RPE', () => editSet(log, { rpe })))) return;
    setRpeFor(null);
  };

  const stepFor = (field: 'kg' | 'reps', p = plan) => {
    if (field === 'reps') return 1;
    const loadType = liveExercises?.find((e) => e?.id === p.exerciseId)?.loadType ?? p.loadType; // live: equipment may have changed
    return loadStep({ loadType }, units) || 1;
  };

  const endSession = async (force = false) => {
    const open = logs.filter((l) => !l.completed && l.setType === 'straight').length;
    if (open && !force) return setSheet('end');
    finishing.current = true;
    let summary: SessionSummary | undefined;
    const ok = await safeWrite('Finishing the session', async () => {
      summary = await finishSession(sessionId);
    });
    if (ok && summary) onFinished(summary);
    else finishing.current = false;
  };

  keyHandler.current = (e) => {
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (sheet) return; // sheets handle their own keys (Esc)
    if (e.key === 'Enter' && tag !== 'BUTTON') {
      e.preventDefault();
      void onDone();
    } else if ((e.key === 'e' || e.key === 'E') && active && !bw) {
      setEditing({ log: active, field: 'kg' });
    } else if ((e.key === 'r' || e.key === 'R') && active) {
      setEditing({ log: active, field: 'reps' });
    } else if (/^[1-9]$/.test(e.key) && rpeFor) {
      void onRpe(RPE_VALUES[Number(e.key) - 1]);
    } else if (e.key === '?') {
      setSheet('keys');
    }
  };

  const jumpTo = (id: string) => {
    setSelectedId(id);
    setSheet(null);
  };

  return (
    <div className="app session">
      <header className="header-strip">
        <SunMark />
        <button className="title" onClick={() => setSheet('programme')} aria-haspopup="dialog">
          Week {session.week} · {day?.name ?? ''} ▾
        </button>
        <SyncBadge />
        <span className="pos">
          {gi + 1} / {groups.length}
        </span>
        <button className="icon-btn" aria-label="Session menu" onClick={() => setSheet('menu')}>
          ⋯
        </button>
      </header>

      <aside className="side-panel" aria-label="Programme">
        <ProgrammeContent groups={groups} session={session} onJump={(id) => setSelectedId(id)} />
      </aside>

      <main className="scroll">
        {session.isDeload && (
          <p style={{ marginTop: 8 }}>
            <span className="chip deload">DELOAD</span>
          </p>
        )}
        <h1 className="ex-name">{plan.name}</h1>
        <p className="ex-sub">
          {plan.sets} sets · {repRange(plan)} reps{rpe ? ` · ${rpe}` : ''}
          {badge && <span className="chip set-type">{badge}</span>}
        </p>
        <ExerciseNotes cue={plan.cue} />

        <section
          className={`set-card ${pulse ? 'pulse' : ''} ${flash ? 'done-flash' : ''}`}
          aria-label={activeHere && active ? `${setLabel(active, working)}, ${fmtLoad(active.kg, bw)} ${bw ? '' : units}, ${active.reps} reps` : 'All sets logged'}
        >
          {activeHere && active ? (
            <>
              <div className="label">
                {active.setType === 'warmup' ? 'Warm-up' : `Set ${workingNo} of ${working.length}`}
                {amrapNow && <span className="chip set-type">AMRAP</span>}
              </div>
              <div className="nums">
                {!bw && (
                  <button className="big-num" onClick={() => setEditing({ log: active, field: 'kg' })} aria-label="Change weight">
                    {active.kg != null ? formatWeight(active.kg) : '—'}
                    <small>{units}</small>
                  </button>
                )}
                <button className="reps-btn" onClick={() => setEditing({ log: active, field: 'reps' })} aria-label="Change reps">
                  {bw ? <span className="big-num">{active.reps}</span> : `× ${active.reps} reps`}
                  {bw && <small className="muted"> reps</small>}
                </button>
                {needsWeight && <p className="ask">What will you lift today?</p>}
              </div>
              {active.setType === 'straight' && (amrapNow || rpe) && (
                <p className="target-line">
                  {amrapNow ? 'As many reps as you can · log every rep' : `Target ${repRange(plan)} reps`}
                  {rpe && !amrapNow && <b> · {rpe}</b>}
                </p>
              )}
              {active.setType === 'warmup' ? (
                <p className="suggestion muted">
                  Warm-up · working sets at {plan.suggestedKg != null ? `${formatWeight(plan.suggestedKg)} ${units}` : 'your chosen weight'}
                </p>
              ) : (
                <SuggestionRow plan={plan} units={units} onWhy={() => setSheet('why')} />
              )}
              {(equipment === 'barbell' || equipment === 'plates') && active.kg != null && (
                <Plates kg={active.kg} units={units} noBar={equipment === 'plates'} />
              )}
            </>
          ) : (
            <div className="label">All sets logged</div>
          )}
        </section>

        <button className="dots" onClick={() => setSheet('sets')} aria-label={`All sets for ${plan.name}`} aria-haspopup="dialog">
          {group.logs.map((l) => (
            <span
              key={l.id}
              className={`dot ${l.setType === 'warmup' ? 'warm' : ''} ${l.completed ? 'done' : l.id === active?.id ? 'active' : ''}`}
            />
          ))}
          <span className="all">All sets</span>
        </button>

        {next && (
          <p className="next-peek">
            Next: <b>{next.plan.name}</b> · {next.plan.sets}×{repRange(next.plan)}
          </p>
        )}
      </main>

      <div className="dock">
        {(timer.running || rpeFor) && (
          <div className={`rest-bar ${timer.running && timer.remainingMs <= 0 ? 'over' : ''}`}>
            {timer.running && (
              <div
                className="progress"
                style={{ transform: `scaleX(${timer.progress})` }}
              />
            )}
            {rpeFor &&
              (() => {
                const rl = logs.find((l) => l.id === rpeFor);
                const rp = rl ? groupOf(rl).plan : plan;
                const lo = rp.targetRpeMin ?? rp.targetRpe;
                return (
                  <div className="rpe-block">
                    <div className="rpe-head">
                      <b>How hard was that?</b>
                      <span className="muted">{rpeText(rp) ? `target ${rpeText(rp)} · ` : ''}RPE, optional</span>
                    </div>
                    <div className="rpe-row" role="group" aria-label="How hard was that set? RPE, optional">
                      {RPE_VALUES.map((r) => (
                        <button
                          key={r}
                          className={`rpe-chip ${rp.targetRpe != null && lo != null && r >= lo && r <= rp.targetRpe ? 'in-target' : ''}`}
                          aria-pressed={rl?.rpe === r}
                          onClick={() => onRpe(r)}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            {timer.running && (
              <div className="row">
                <span className="time" role="timer">
                  <small>{timer.remainingMs > 0 ? 'REST' : timer.justFinished ? 'GO' : 'REST OVER'}</small>
                  {timer.remainingMs > 0 ? fmtClock(timer.remainingMs) : `+${fmtClock(-timer.remainingMs)}`}
                </span>
                <button className="rbtn" onClick={() => timer.add(30)} aria-label="Add 30 seconds">
                  +30s
                </button>
                <button className="rbtn" onClick={() => timer.skip()}>
                  Skip
                </button>
              </div>
            )}
          </div>
        )}
        <button
          className="btn-primary"
          onClick={onDone}
          disabled={!active || needsWeight}
          aria-label={
            active ? `Log ${setLabel(active, working)}: ${fmtLoad(active.kg, bw)} ${bw ? '' : units} for ${active.reps} reps` : 'All sets logged'
          }
        >
          Done ✓
        </button>
      </div>

      <div className="sr-only" aria-live="polite">
        {announce}
      </div>

      {toast && (
        <div className={`toast ${toast.logId ? '' : 'solo'}`} role="status">
          {toast.text}
          {toast.logId && <button onClick={onUndo}>UNDO</button>}
        </div>
      )}

      {editing && (
        <EditSheet
          title={`${editing.field === 'kg' ? 'Weight' : 'Reps'} · ${groupOf(editing.log).plan.name}`}
          value={editing.field === 'kg' ? (editing.log.kg ?? startingWeight(groupOf(editing.log).plan.loadType, units)) : editing.log.reps}
          step={stepFor(editing.field, groupOf(editing.log).plan)}
          unit={editing.field === 'kg' ? units : 'reps'}
          decimals={editing.field === 'kg'}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            const { log, field } = editing;
            const ok = await safeWrite(field === 'kg' ? 'The weight' : 'The reps', () =>
              editSet(log, field === 'kg' ? { kg: v } : { reps: Math.round(v) }),
            );
            if (ok) setEditing(null);
          }}
        />
      )}

      {sheet === 'why' && (
        <WhySheet
          plan={plan}
          units={units}
          onClose={() => setSheet(null)}
          onChange={() => {
            setSheet(null);
            if (active) setEditing({ log: active, field: 'kg' });
          }}
        />
      )}

      {sheet === 'sets' && (
        <SetListSheet
          groups={groups}
          currentId={plan.dayExerciseId}
          activeId={active?.id ?? null}
          units={units}
          onClose={() => setSheet(null)}
          onPick={(l) => {
            if (l.completed) {
              setRowLog(l);
              setSheet('row');
            } else jumpTo(l.id);
          }}
        />
      )}

      {sheet === 'row' &&
        rowLog &&
        (() => {
          const rg = groupOf(rowLog);
          const rbw = rg.plan.loadType === 'bodyweight';
          const rworking = rg.logs.filter((l) => l.setType === 'straight');
          return (
        <Sheet label="Edit logged set" onClose={() => setSheet(null)}>
          <h2>
            {rg.plan.name} · {setLabel(rowLog, rworking)} · {fmtLoad(rowLog.kg, rbw)} × {rowLog.reps}
            {rowLog.rpe ? ` · RPE ${rowLog.rpe}` : ''}
          </h2>
          {!rbw && (
            <button
              className="menu-item"
              onClick={() => {
                setSheet(null);
                setEditing({ log: rowLog, field: 'kg' });
              }}
            >
              Change weight
            </button>
          )}
          <button
            className="menu-item"
            onClick={() => {
              setSheet(null);
              setEditing({ log: rowLog, field: 'reps' });
            }}
          >
            Change reps
          </button>
          {rowLog.setType === 'straight' && (
            <button
              className="menu-item"
              onClick={() => {
                setSheet(null);
                setRpeFor(rowLog.id);
              }}
            >
              Set RPE
            </button>
          )}
          <button
            className="menu-item"
            onClick={async () => {
              if (!(await safeWrite('That set', () => undoSet(rowLog.id)))) return;
              jumpTo(rowLog.id);
            }}
          >
            Mark as not done
          </button>
        </Sheet>
          );
        })()}

      {sheet === 'programme' && (
        <Sheet label="Programme" onClose={() => setSheet(null)}>
          <ProgrammeContent groups={groups} session={session} onJump={jumpTo} />
        </Sheet>
      )}

      {sheet === 'menu' && (
        <Sheet label="Session menu" onClose={() => setSheet(null)}>
          <h2>Session</h2>
          <button
            className="menu-item"
            onClick={() => {
              setSheet(null);
              void endSession();
            }}
          >
            End session
          </button>
          <button className="menu-item" onClick={() => setSheet('equipment')}>
            Equipment: {equipmentLabel(equipment)}
          </button>
          {!touchOnly && (
            <button className="menu-item" onClick={() => setSheet('keys')}>
              Keyboard shortcuts
            </button>
          )}
          <button
            className="menu-item"
            onClick={async () => {
              if (!window.confirm('Discard this session? Nothing from it will be saved.')) return;
              await safeWrite('Discarding the session', () => discardSession(sessionId));
            }}
          >
            Discard session
          </button>
        </Sheet>
      )}

      {sheet === 'equipment' && (
        <Sheet label="Equipment" onClose={() => setSheet(null)}>
          <h2>Equipment · {plan.name}</h2>
          <p className="muted">Sets the weight steps and the plate picture for this exercise, from now on.</p>
          <ul className="sheet-list">
            {EQUIPMENT.map((e) => (
              <li key={e.value}>
                <button
                  aria-pressed={equipment === e.value}
                  onClick={async () => {
                    if (await safeWrite('Equipment', () => setExerciseLoadType(plan.exerciseId, e.value))) setSheet(null);
                  }}
                >
                  <span className="mark">{equipment === e.value ? '✓' : ''}</span>
                  <span>{e.label}</span>
                  {e.value === 'plates' && <span className="side">leg press, hack squat…</span>}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {sheet === 'keys' && (
        <Sheet label="Keyboard shortcuts" onClose={() => setSheet(null)}>
          <h2>Keyboard shortcuts</h2>
          <ul className="kbd-list">
            <li>
              Log the set <kbd>Enter</kbd>
            </li>
            <li>
              Edit weight <kbd>E</kbd>
            </li>
            <li>
              Edit reps <kbd>R</kbd>
            </li>
            <li>
              RPE 6 … 10 (after a set) <kbd>1 – 9</kbd>
            </li>
            <li>
              Close a sheet <kbd>Esc</kbd>
            </li>
            <li>
              This list <kbd>?</kbd>
            </li>
          </ul>
        </Sheet>
      )}

      {sheet === 'end' && (
        <Sheet label="Finish session" onClose={() => setSheet(null)}>
          <h2>{logs.filter((l) => !l.completed && l.setType === 'straight').length} sets not logged</h2>
          <p className="muted">They'll be marked skipped.</p>
          <div className="sheet-actions">
            <button className="btn-secondary" onClick={() => setSheet(null)}>
              Keep going
            </button>
            <button
              className="btn-primary compact"
              onClick={() => {
                setSheet(null);
                void endSession(true);
              }}
            >
              Finish
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
