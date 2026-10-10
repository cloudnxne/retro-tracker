import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSetting, getUnits, setSetting, startSession, takeEarlyDeload, type TodayState } from '../../db/repo';
import { formatWeight } from '../../engine/copy';
import { shouldOfferEarlyDeload } from '../../engine/schedule';
import { unlockAudio } from '../../lib/sound';
import { isStandalone } from '../../lib/install';
import { Sheet } from '../../ui/Sheet';
import { InstallCard } from '../../ui/InstallCard';
import { safeWrite } from '../../lib/safeWrite';
import { useBackupNudge } from '../../lib/useBackupNudge';
import { downloadBackup } from '../../lib/backup';
import { FuelRow } from './FuelRow';
import { SunMark } from '../../ui/SunMark';

type Ready = Extract<TodayState, { kind: 'ready' }>;

/** "Before first set": the day's list, estimated time, one START button. */
export function ReadyScreen({ state }: { state: Ready }) {
  const units = useLiveQuery(getUnits, []) ?? 'kg';
  const offer = useLiveQuery(async () => {
    if (state.isDeload) return false;
    const snooze = await getSetting<number>('earlyDeloadSnoozeUntil', 0);
    if (Date.now() < snooze) return false;
    const since = Date.now() - 7 * 86_400_000;
    const resets = await db().events.where('ts').above(since).filter((e) => e.name === 'suggestion_reset').toArray();
    return shouldOfferEarlyDeload(resets.map((e) => ({ exerciseId: String(e.payload.exerciseId), at: e.ts })), Date.now());
  }, [state.isDeload]);
  const tipSeen = useLiveQuery(() => getSetting('wakeTipSeen', false), []);
  // Storage.persist() was refused → nudge to install so iOS won't evict saved sets.
  const persistWarn = useLiveQuery(
    async () =>
      (await getSetting<boolean | null>('persistGranted', null)) === false &&
      !(await getSetting('persistBannerDismissed', false)) &&
      !isStandalone(),
    [],
  );
  const [showInstall, setShowInstall] = useState(false);
  const backup = useBackupNudge();

  const sets = state.plan.reduce((n, p) => n + p.sets + p.warmups.length, 0);
  const minutes = Math.round(state.plan.reduce((t, p) => t + (p.sets + p.warmups.length) * (45 + p.restSec), 0) / 60);

  const takeDeload = () => takeEarlyDeload(state.ap, state.week);

  return (
    <>
      <header className="header-strip">
        <SunMark />
        <span className="title">
          Week {state.week} · {state.blockName}
        </span>
      </header>
      <main className="scroll">
        <h1 className="page-title">{state.dayName}</h1>
        {state.isDeload && (
          <p>
            <span className="chip deload">DELOAD</span>{' '}
            <span className="muted">60% and one set fewer. Should feel easy. That's the point.</span>
          </p>
        )}
        {state.elsewhere && (
          <div className="banner info" role="status">
            <p>
              Workout in progress on another device (started{' '}
              {new Date(state.elsewhere.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). Finish it
              there and it will show up here.
            </p>
          </div>
        )}
        {backup.due && (
          <div className="banner info" role="region" aria-label="Back up your data">
            <p>
              <strong>Back up your data.</strong> Until cloud sync is on, this phone holds the only copy of your workouts.
            </p>
            <div className="row">
              <button className="btn-secondary" onClick={() => void safeWrite('Saving the backup', downloadBackup)}>
                Back up now
              </button>
              <button className="btn-secondary" onClick={() => void backup.snooze()}>
                Later
              </button>
            </div>
          </div>
        )}
        {persistWarn && (
          <div className="banner info" role="region" aria-label="Keep your sets safe">
            <p>Add the app to your Home Screen so your phone doesn't clear saved sets.</p>
            <div className="row">
              <button className="btn-secondary" onClick={() => setShowInstall(true)}>
                How
              </button>
              <button className="btn-secondary" onClick={() => setSetting('persistBannerDismissed', true)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {offer && (
          <div className="banner" role="region" aria-label="Deload suggestion">
            <p>Two lifts stalled twice this week. Take a deload week?</p>
            <div className="row">
              <button className="btn-secondary" onClick={takeDeload}>
                Take it
              </button>
              <button
                className="btn-secondary"
                onClick={() => setSetting('earlyDeloadSnoozeUntil', Date.now() + 7 * 86_400_000)}
              >
                Not now
              </button>
            </div>
          </div>
        )}
        <p className="muted" style={{ marginTop: 8 }}>
          {state.plan.length} exercises · {sets} sets · ~{minutes} min
        </p>
        <ul className="day-list">
          {state.plan.map((p) => (
            <li key={p.dayExerciseId}>
              <span>{p.name}</span>
              <span className="muted">
                {p.sets}×{p.repMin === p.repMax ? p.repMin : `${p.repMin}–${p.repMax}`}
                {p.suggestedKg != null && p.loadType !== 'bodyweight' ? ` · ${formatWeight(p.suggestedKg)} ${units}` : ''}
                {p.outcome === 'increase' ? ' ▲' : ''}
              </span>
            </li>
          ))}
        </ul>
        {!tipSeen && (
          <p className="muted">Tip: keep the app open on the bench and the bell rings when rest is up.</p>
        )}
      </main>
      <div className="dock">
        <FuelRow />
        <button
          className="btn-primary"
          onClick={async () => {
            unlockAudio();
            await setSetting('wakeTipSeen', true);
            await safeWrite('Starting the session', () => startSession(state));
          }}
        >
          Start session
        </button>
      </div>
      {showInstall && (
        <Sheet label="Install app" onClose={() => setShowInstall(false)}>
          <InstallCard />
        </Sheet>
      )}
    </>
  );
}
