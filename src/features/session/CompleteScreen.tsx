import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { completedSessionCount, getSetting, getUnits, today, type SessionSummary } from '../../db/repo';
import { formatWeight } from '../../engine/copy';
import { prFanfare } from '../../lib/sound';
import { fmtClock } from '../../lib/useRestTimer';
import { isStandalone } from '../../lib/install';
import { InstallCard } from '../../ui/InstallCard';

/** Payoff screen (striped half-sun, rises on a PR). The install card shows after the FIRST session only. */
export function CompleteScreen({ summary, onDone }: { summary: SessionSummary; onDone: () => void }) {
  const units = useLiveQuery(getUnits, []) ?? 'kg';
  const next = useLiveQuery(today, []);
  const showInstall = useLiveQuery(
    async () => !isStandalone() && !(await getSetting('installDismissed', false)) && (await completedSessionCount()) === 1,
    [],
  );
  const hasPr = summary.prs.length > 0;

  useEffect(() => {
    if (!hasPr) return;
    void getSetting('soundOn', true).then((on) => on && prFanfare());
  }, [hasPr]);

  return (
    <main className={`frame-screen ${hasPr ? 'pr-moment' : ''}`}>
      <div className="sun" aria-hidden="true" />
      <h1 className="display">Session complete.</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        {fmtClock(summary.durationMs)}
        {summary.skipped ? ` · ${summary.skipped} sets skipped` : ''}
      </p>
      <div className="stats">
        <div className="stat">
          <b>{summary.setsLogged}</b>
          <span>Sets</span>
        </div>
        <div className="stat">
          <b>{summary.volumeKg.toLocaleString()}</b>
          <span>{units} moved</span>
        </div>
        <div className="stat">
          <b>{summary.progressed}</b>
          <span>▲ Up</span>
        </div>
      </div>
      {summary.prs.map((pr) => (
        <div key={pr.name} className="pr">
          <div className="k">NEW PR · {pr.name.toUpperCase()}</div>
          <div className="v">
            e1RM {formatWeight(pr.e1rm)} {units}
            {pr.delta ? ` (+${formatWeight(pr.delta)})` : ''}
          </div>
        </div>
      ))}
      <p className="muted" style={{ margin: '16px 0 20px' }}>
        {next?.kind === 'ready'
          ? `Next: Week ${next.week} · ${next.dayName}`
          : next?.kind === 'finished'
            ? 'That was the last session of the programme.'
            : ''}
      </p>
      {showInstall && <InstallCard dismissible />}
      <button className="btn-primary" onClick={onDone}>
        Done
      </button>
    </main>
  );
}
