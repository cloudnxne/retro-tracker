import { useState } from 'react';
import type { LoadType } from '../../engine/types';
import { getUnits } from '../../db/repo';
import { commitImport, previewImport, type ImportPreview, type ImportResult } from '../../db/importHistory';
import { parseCsv } from '../../import/csv';
import { detectFormat, parseStrong, SOURCE_LABEL, type ParsedImport } from '../../import/strong';
import { parseTrackerLogs } from '../../import/trackerLog';
import { isStandalone } from '../../lib/install';
import { downloadBackup } from '../../lib/backup';
import { errorSummary, logDiagnostic } from '../../lib/diagnostics';
import { describeWriteError } from '../../lib/safeWrite';
import { count, fmtCount } from '../../lib/plural';

/**
 * ME → Import history: a Strong CSV or the PHP tracker's JSON logs.
 *   pick file ─▶ reading (progress) ─▶ preview (counts, row errors, review list) ─▶ importing ─▶ done
 * Nothing is written until "Import". The write is all-or-nothing.
 */
type Phase =
  | { kind: 'pick' }
  | { kind: 'reading'; progress: number }
  | { kind: 'refused'; message: string }
  | { kind: 'preview'; preview: ImportPreview }
  | { kind: 'importing' }
  | { kind: 'done'; result: ImportResult }
  | { kind: 'failed'; message: string };

const LOAD_TYPES: { value: LoadType; label: string }[] = [
  { value: 'barbell', label: 'Barbell' },
  { value: 'dumbbell', label: 'Dumbbell' },
  { value: 'machine', label: 'Machine / cable (stack)' },
  { value: 'plates', label: 'Plate-loaded machine' },
  { value: 'bodyweight', label: 'Bodyweight' },
];
const fmt = fmtCount;
const month = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

export function ImportHistory({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [acceptErrors, setAcceptErrors] = useState(false);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [loadTypes, setLoadTypes] = useState<Record<string, LoadType>>({});
  const [backedUp, setBackedUp] = useState(false);
  const installed = isStandalone();

  const readStrong = async (file: File): Promise<ParsedImport | string> => {
    const rows = await parseCsv(await file.text(), { onProgress: (p) => setPhase({ kind: 'reading', progress: p }) });
    const format = rows.length ? detectFormat(rows[0]) : 'unknown';
    if (format === 'hevy') return "That's a Hevy export. Hevy import is coming: send us your export and we'll add it.";
    if (format !== 'strong') return "This isn't a Strong export. In Strong: Settings → Export data, then pick that file.";
    return parseStrong(rows, await getUnits());
  };

  /** Tracker logs: one JSON file per workout, picked together. */
  const readTracker = async (list: File[]): Promise<ParsedImport | string> => {
    const files: { name: string; json: unknown }[] = [];
    for (let i = 0; i < list.length; i++) {
      setPhase({ kind: 'reading', progress: i / list.length });
      let json: unknown = null;
      try {
        json = JSON.parse(await list[i].text());
      } catch {
        /* reported as "not a workout log" */
      }
      files.push({ name: list[i].name, json });
    }
    return parseTrackerLogs(files, await getUnits());
  };

  const read = async (list: File[]) => {
    setPhase({ kind: 'reading', progress: 0 });
    try {
      const csv = list.filter((f) => /.csv$/i.test(f.name) || f.type === 'text/csv');
      if (csv.length && csv.length !== list.length) {
        return setPhase({ kind: 'refused', message: 'Pick either one Strong CSV or your tracker JSON files, not both at once.' });
      }
      if (csv.length > 1) return setPhase({ kind: 'refused', message: 'Pick one Strong export at a time.' });
      const parsed = csv.length ? await readStrong(csv[0]) : await readTracker(list);
      if (typeof parsed === 'string') return setPhase({ kind: 'refused', message: parsed });
      if (!parsed.workouts.length) return setPhase({ kind: 'refused', message: 'No workouts found in what you picked.' });
      setPhase({ kind: 'preview', preview: await previewImport(parsed) });
    } catch (e) {
      void logDiagnostic('import', `read failed: ${errorSummary(e)}`);
      setPhase({ kind: 'refused', message: "Couldn't read that file." });
    }
  };

  const run = async (preview: ImportPreview) => {
    setPhase({ kind: 'importing' });
    try {
      const result = await commitImport(preview, { loadTypes, removeMissing });
      void logDiagnostic(
        'import',
        `${preview.parsed.source}: ${result.workouts} workouts, ${result.sets} sets, ${result.removed} removed, ${preview.parsed.errors.length} rows skipped`,
      );
      setPhase({ kind: 'done', result });
    } catch (e) {
      void logDiagnostic('import', `commit failed: ${errorSummary(e)}`);
      setPhase({ kind: 'failed', message: describeWriteError(e) });
    }
  };

  if (phase.kind === 'pick' || phase.kind === 'refused') {
    return (
      <>
        <h2>Import history</h2>
        <p className="muted">
          Your past workouts become your LAST TIME, PRs and progress here. Pick your Strong export (Settings → Export data in
          Strong), or select all your tracker log files (.json) at once.
        </p>
        {!installed && (
          <div className="banner" role="note">
            <p>
              <strong>Install the app first.</strong> On iPhone, Safari can clear data for websites that aren't on your Home
              Screen, and that would erase your imported history.
            </p>
          </div>
        )}
        {phase.kind === 'refused' && (
          <p role="alert" style={{ color: 'var(--warn)', marginTop: 12 }}>
            {phase.message}
          </p>
        )}
        <label className="btn-primary" style={{ marginTop: 16, display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
          Choose files
          <input
            type="file"
            accept=".csv,text/csv,.json,application/json"
            multiple
            hidden
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = '';
              if (list.length) void read(list);
            }}
          />
        </label>
      </>
    );
  }

  if (phase.kind === 'reading' || phase.kind === 'importing') {
    const label = phase.kind === 'reading' ? 'Reading your history…' : 'Importing… keep the app open';
    return (
      <>
        <h2>Import history</h2>
        <p role="status">{label}</p>
        <progress
          max={1}
          value={phase.kind === 'reading' ? phase.progress : undefined}
          aria-label={label}
          style={{ width: '100%' }}
        />
      </>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <>
        <h2>Import didn't finish</h2>
        <p role="alert" style={{ color: 'var(--warn)' }}>
          Nothing was imported ({phase.message}). Your existing data is unchanged.
        </p>
        <button className="btn-secondary" onClick={() => setPhase({ kind: 'pick' })}>
          Try again
        </button>
      </>
    );
  }

  if (phase.kind === 'done') {
    const r = phase.result;
    return (
      <>
        <h2>History imported</h2>
        <p>
          {count(r.workouts, 'workout')} and {count(r.sets, 'set')} are now in the app
          {r.removed ? `, ${fmt(r.removed)} old workouts removed` : ''}.
        </p>
        <p className="muted" style={{ marginTop: 8 }}>
          Until cloud sync is on, this phone holds the only copy. Save a backup now.
        </p>
        <div className="stack" style={{ marginTop: 16 }}>
          <button
            className="btn-primary"
            onClick={async () => {
              await downloadBackup();
              setBackedUp(true);
            }}
          >
            {backedUp ? 'Backup saved ✓' : 'Back up now'}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </>
    );
  }

  const p = phase.preview;
  const errors = p.parsed.errors;
  const review = p.exercises.filter((e) => !e.certain && !e.existing);
  const { restTimers, notes, cardio, untickedUnchanged = 0, duplicateSaves = 0, templates = 0 } = p.parsed.skipped;
  const from = SOURCE_LABEL[p.parsed.source];
  const canImport = p.workouts.length > 0 && (errors.length === 0 || acceptErrors);
  return (
    <>
      <h2>Import history</h2>
      <p className="muted">From {p.parsed.source === 'strong' ? 'your Strong export' : 'your tracker logs'}</p>
      <p>
        <strong>{count(p.workouts.length, 'workout')}</strong> · {count(p.sets, 'set')}
        {p.range ? ` · ${month(p.range.from)} – ${month(p.range.to)}` : ''}
      </p>
      <ul className="muted" style={{ margin: '8px 0 0 18px' }}>
        {p.alreadyImported > 0 && <li>{fmt(p.alreadyImported)} already imported: they'll be refreshed, not duplicated.</li>}
        {p.parsed.source === 'strong' ? (
          <li>
            Skipped (not sets): {count(restTimers, 'rest timer')}, {count(notes, 'note')}
            {cardio ? `, ${count(cardio, 'cardio entry', 'cardio entries')}` : ''}.
          </li>
        ) : (
          <>
            {untickedUnchanged > 0 && <li>{count(untickedUnchanged, 'unticked set')} left as prefilled: skipped (never done).</li>}
            {duplicateSaves > 0 && <li>{count(duplicateSaves, 'workout')} saved twice: the latest save is kept.</li>}
            {templates > 0 && <li>{count(templates, 'programme template')} ignored (not workouts).</li>}
          </>
        )}
        {p.replaces.length > 0 && (
          <li>
            Replaces {count(p.replaces.length, 'workout')} from {SOURCE_LABEL[p.replaces[0].from]} logged on the same days.
          </li>
        )}
        {p.covered.length > 0 && (
          <li>
            {count(p.covered.length, 'workout')} skipped: already imported from your {SOURCE_LABEL[p.covered[0].by]}s for those
            days.
          </li>
        )}
        {p.overlaps.length > 0 && <li>{fmt(p.overlaps.length)} workouts skipped: you already logged them in this app.</li>}
      </ul>

      {errors.length > 0 && (
        <div className="banner" role="alert">
          <p>
            <strong>{errors.length === 1 ? "1 row can't be read" : `${fmt(errors.length)} rows can't be read`}</strong> and won't be imported:
          </p>
          <ul style={{ margin: '0 0 8px 18px' }}>
            {errors.slice(0, 8).map((e) => (
              <li key={e.row}>
                Row {e.row}: {e.message}
              </li>
            ))}
            {errors.length > 8 && <li>…and {fmt(errors.length - 8)} more</li>}
          </ul>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={acceptErrors} onChange={(e) => setAcceptErrors(e.target.checked)} />
            Import the rest
          </label>
        </div>
      )}

      {p.missing.length > 0 && (
        <label className="banner info" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
          Remove {fmt(p.missing.length)} previously imported {from} workouts that are no longer in what you picked
        </label>
      )}

      {review.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary>
            Check {fmt(review.length)} exercise {review.length === 1 ? 'type' : 'types'} (no equipment in the name)
          </summary>
          <p className="muted" style={{ margin: '8px 0' }}>
            We guessed. The type sets weight steps and the plate maths; you can change it later too.
          </p>
          {review.map((e) => (
            <div className="setting-row" key={e.name}>
              <span>{e.name}</span>
              <select
                aria-label={`Type for ${e.name}`}
                value={loadTypes[e.name] ?? e.loadType}
                onChange={(ev) => setLoadTypes({ ...loadTypes, [e.name]: ev.target.value as LoadType })}
              >
                {LOAD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </details>
      )}

      <div className="stack" style={{ marginTop: 16 }}>
        <button className="btn-primary" disabled={!canImport} onClick={() => void run(p)}>
          Import {count(p.workouts.length, 'workout')}
        </button>
        <button className="btn-secondary" onClick={() => setPhase({ kind: 'pick' })}>
          Choose a different file
        </button>
      </div>
    </>
  );
}
