import { useState } from 'react';
import { BackupError, previewRestore, restoreBackup, type RestorePreview } from '../../db/restore';
import { errorSummary, logDiagnostic } from '../../lib/diagnostics';
import { describeWriteError } from '../../lib/safeWrite';
import { count } from '../../lib/plural';

/**
 * ME → Restore from backup. Replace-all: the phone ends up exactly as the
 * backup was. Nothing changes until "Replace…" is tapped; a failure changes nothing.
 */
type Phase =
  | { kind: 'pick'; error?: string }
  | { kind: 'preview'; preview: RestorePreview }
  | { kind: 'restoring' }
  | { kind: 'failed'; message: string };


export function RestoreBackup() {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });

  const read = async (file: File) => {
    try {
      setPhase({ kind: 'preview', preview: await previewRestore(JSON.parse(await file.text())) });
    } catch (e) {
      setPhase({ kind: 'pick', error: e instanceof BackupError ? e.message : "Couldn't read that file. Pick the .json backup." });
    }
  };

  const run = async (p: RestorePreview) => {
    setPhase({ kind: 'restoring' });
    try {
      const r = await restoreBackup(p);
      void logDiagnostic('restore', `restored ${r.rows} rows from backup of ${p.exportedAt ?? 'unknown date'}`);
      window.location.reload();
    } catch (e) {
      void logDiagnostic('restore', `restore failed: ${errorSummary(e)}`);
      setPhase({ kind: 'failed', message: describeWriteError(e) });
    }
  };

  if (phase.kind === 'pick') {
    return (
      <>
        <h2>Restore from backup</h2>
        <p className="muted">Pick a backup file saved from this app (retro-tracker-….json).</p>
        {phase.error && (
          <p role="alert" style={{ color: 'var(--warn)', marginTop: 12 }}>
            {phase.error}
          </p>
        )}
        <label className="btn-primary" style={{ marginTop: 16, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
          Choose backup file
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void read(f);
            }}
          />
        </label>
      </>
    );
  }

  if (phase.kind === 'restoring') {
    return (
      <>
        <h2>Restore from backup</h2>
        <p role="status">Restoring… keep the app open</p>
        <progress aria-label="Restoring" style={{ width: '100%' }} />
      </>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <>
        <h2>Restore didn't finish</h2>
        <p role="alert" style={{ color: 'var(--warn)' }}>
          Nothing changed ({phase.message}). Your current data is as it was.
        </p>
        <button className="btn-secondary" onClick={() => setPhase({ kind: 'pick' })}>
          Try again
        </button>
      </>
    );
  }

  const p = phase.preview;
  const c = p.counts;
  return (
    <>
      <h2>Restore from backup</h2>
      <p>
        Backup from <strong>{p.exportedAt ? new Date(p.exportedAt).toLocaleString() : 'an unknown date'}</strong>
      </p>
      <ul className="muted" style={{ margin: '8px 0 0 18px' }}>
        <li>
          {count(c.sessions, 'workout')}, {count(c.setLogs, 'set')}
        </li>
        <li>{count(c.programmes, 'programme')}</li>
        {(c.nutritionDays ?? 0) + (c.bodyweightLogs ?? 0) > 0 && (
          <li>
            {count(c.nutritionDays, 'FUEL day')}, {count(c.bodyweightLogs, 'bodyweight')}
          </li>
        )}
      </ul>
      {p.replacesData && (
        <div className="banner" role="note">
          <p>
            <strong>This replaces everything on this phone</strong> with the backup. Anything logged since the backup was made
            will be gone.
          </p>
        </div>
      )}
      <div className="stack" style={{ marginTop: 16 }}>
        <button className={p.replacesData ? 'btn-danger' : 'btn-primary'} onClick={() => void run(p)}>
          {p.replacesData ? 'Replace everything with this backup' : 'Restore'}
        </button>
        <button className="btn-secondary" onClick={() => setPhase({ kind: 'pick' })}>
          Choose a different file
        </button>
      </div>
    </>
  );
}
