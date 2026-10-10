import { Suspense, useState } from 'react';
import { lazyScreen } from '../../ui/ScreenBoundary';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  completedSessionCount,
  deleteLocalData,
  exportSetsCsv,
  getSetting,
  getUnits,
  isSignedIn,
  pendingSyncCount,
  setSetting,
  switchAccount,
} from '../../db/repo';
import { GUEST } from '../../db/schema';
import { deleteMyAccount, shareWithCoach, signOut, syncConfigured } from '../../sync/supabase';
import { useSyncStatus } from '../../sync/runner';
import { SignIn } from '../auth/SignIn';
import { setThemePref, type ThemePref } from '../../lib/theme';
import { Sheet } from '../../ui/Sheet';
import { InstallCard } from '../../ui/InstallCard';
import { ImportButton } from './ImportButton';
import { PlateSetup, usePlateSummary } from './PlateSetup';
// Used once per user: kept out of the main bundle (bundle size budget).
const ImportHistory = lazyScreen(() => import('./ImportHistory').then((m) => ({ default: m.ImportHistory })));
const RestoreBackup = lazyScreen(() => import('./RestoreBackup').then((m) => ({ default: m.RestoreBackup })));
import { downloadBackup, downloadFile, todayStamp } from '../../lib/backup';
import { applyUpdateNow, useUpdateReady } from '../../lib/appUpdate';
import { APP_VERSION, diagnosticsReport } from '../../lib/diagnostics';
import { SunMark } from '../../ui/SunMark';

const download = downloadFile;
const today = todayStamp;

export function MeScreen({ onDeleted }: { onDeleted: () => void }) {
  const units = useLiveQuery(getUnits, []) ?? 'kg';
  const soundOn = useLiveQuery(() => getSetting('soundOn', true), []) ?? true;
  const theme = useLiveQuery(() => getSetting<ThemePref>('theme', 'auto'), []) ?? 'auto';
  const pending = useLiveQuery(pendingSyncCount, []) ?? 0;
  const sessions = useLiveQuery(completedSessionCount, []) ?? 0;
  const [sheet, setSheet] = useState<'export' | 'delete' | 'install' | 'signout' | 'share' | 'import-history' | 'restore' | 'plates' | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [shareCode, setShareCode] = useState('');
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const email = useLiveQuery(() => getSetting<string>('email', ''), []);
  const plateSummary = usePlateSummary();
  const lastBackupAt = useLiveQuery(() => getSetting<number | null>('lastBackupAt', null), []);
  const gPerKg = useLiveQuery(() => getSetting<number>('proteinTarget', 1.6), []) ?? 1.6;
  const setGPerKg = (v: number) => setSetting('proteinTarget', Math.round(Math.min(3, Math.max(0.8, v)) * 10) / 10);
  const syncStatus = useSyncStatus();
  const signedIn = isSignedIn();
  const [confirmText, setConfirmText] = useState('');
  const updateReady = useUpdateReady();
  const [appMsg, setAppMsg] = useState<string | null>(null);

  // Every hook above this line: an early return before a hook breaks React's hook order.
  if (signingIn) return <SignIn onDone={() => window.location.reload()} onSkip={() => setSigningIn(false)} />;

  return (
    <>
      <header className="header-strip">
        <SunMark />
        <span className="title">Me</span>
      </header>
      <main className="scroll">
        <h1 className="page-title">Settings</h1>
        <div className="setting-row">
          <span>Units</span>
          <div className="seg" role="group" aria-label="Units">
            {(['kg', 'lb'] as const).map((u) => (
              <button key={u} aria-pressed={units === u} onClick={() => setSetting('units', u)}>
                {u}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Theme</span>
          <div className="seg" role="group" aria-label="Theme">
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <button key={t} aria-pressed={theme === t} onClick={() => setThemePref(t)}>
                {t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Sounds</span>
          <div className="seg" role="group" aria-label="Sounds">
            <button aria-pressed={soundOn} onClick={() => setSetting('soundOn', true)}>
              On
            </button>
            <button aria-pressed={!soundOn} onClick={() => setSetting('soundOn', false)}>
              Off
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>
            Plates & bar
            {plateSummary && <small className="muted setting-sub">{plateSummary}</small>}
          </span>
          <button className="btn-secondary" style={{ width: 'auto', padding: '0 16px' }} onClick={() => setSheet('plates')}>
            Edit
          </button>
        </div>
        <div className="setting-row">
          <span>Protein target</span>
          <div className="seg" role="group" aria-label="Protein target, grams per kg of bodyweight">
            <button aria-label="Lower protein target" onClick={() => setGPerKg(gPerKg - 0.1)}>
              −
            </button>
            <output className="seg-value" aria-live="polite">
              {gPerKg.toFixed(1)} g/kg
            </output>
            <button aria-label="Raise protein target" onClick={() => setGPerKg(gPerKg + 0.1)}>
              +
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>Cloud sync</span>
          <span className="muted" style={{ textAlign: 'right' }}>
            {!syncConfigured
              ? `Not set up yet · ${pending} changes saved on this phone`
              : !signedIn
                ? 'Off, sign in to back up'
                : syncStatus === 'offline'
                  ? `Offline · ${pending} waiting`
                  : syncStatus === 'failed'
                    ? 'Some changes could not sync'
                    : 'On'}
          </span>
        </div>
        {syncConfigured && (
          <div className="setting-row">
            <span>{signedIn ? `Signed in${email ? ` as ${email}` : ''}` : 'Account'}</span>
            {signedIn ? (
              <button className="btn-secondary" style={{ width: 'auto', padding: '0 16px' }} onClick={() => setSheet('signout')}>
                Sign out
              </button>
            ) : (
              <button className="btn-secondary" style={{ width: 'auto', padding: '0 16px' }} onClick={() => setSigningIn(true)}>
                Sign in
              </button>
            )}
          </div>
        )}
        {syncConfigured && signedIn && (
          <div className="setting-row">
            <span>Your PT</span>
            <button
              className="btn-secondary"
              style={{ width: 'auto', padding: '0 16px' }}
              onClick={() => {
                setShareMsg(null);
                setShareCode('');
                setSheet('share');
              }}
            >
              Share with PT
            </button>
          </div>
        )}
        <div className="setting-row">
          <span>Install app</span>
          <button className="btn-secondary" style={{ width: 'auto', padding: '0 16px' }} onClick={() => setSheet('install')}>
            How
          </button>
        </div>

        <h2 className="section-title">App</h2>
        <div className="setting-row">
          <span>Version {APP_VERSION}</span>
          {updateReady ? (
            <button
              className="btn-secondary"
              style={{ width: 'auto', padding: '0 16px' }}
              onClick={async () => {
                if (!(await applyUpdateNow())) setAppMsg('Finish your workout first, then update.');
              }}
            >
              Restart to update
            </button>
          ) : (
            <span className="muted">Up to date</span>
          )}
        </div>
        <div className="setting-row">
          <span>Diagnostics</span>
          <button
            className="btn-secondary"
            style={{ width: 'auto', padding: '0 16px' }}
            onClick={async () => {
              const text = await diagnosticsReport();
              try {
                await navigator.clipboard.writeText(text);
                setAppMsg('Copied. No workout numbers are included.');
              } catch {
                download(`retro-diagnostics-${today()}.txt`, 'text/plain', text);
                setAppMsg('Saved as a file. No workout numbers are included.');
              }
            }}
          >
            Copy
          </button>
        </div>
        {appMsg && (
          <p className="muted" role="status">
            {appMsg}
          </p>
        )}

        <h2 className="section-title">Programme</h2>
        <ImportButton />

        <h2 className="section-title">History</h2>
        <button className="btn-secondary" onClick={() => setSheet('import-history')}>
          Import past workouts
        </button>

        <h2 className="section-title">Your data</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          {lastBackupAt ? `Last backup: ${new Date(lastBackupAt).toLocaleDateString()}` : 'No backup saved yet.'}
        </p>
        <div className="stack">
          <button className="btn-secondary" onClick={() => setSheet('export')}>
            Export my data
          </button>
          <button className="btn-secondary" onClick={() => setSheet('restore')}>
            Restore from backup
          </button>
          <button
            className="btn-secondary"
            style={{ color: 'var(--warn)' }}
            onClick={() => {
              setConfirmText('');
              setSheet('delete');
            }}
          >
            Delete everything
          </button>
        </div>
      </main>

      {sheet === 'import-history' && (
        <Sheet label="Import history" onClose={() => setSheet(null)}>
          <Suspense fallback={<p role="status">Loading…</p>}>
            <ImportHistory onClose={() => setSheet(null)} />
          </Suspense>
        </Sheet>
      )}

      {sheet === 'plates' && (
        <Sheet label="Plates & bar" onClose={() => setSheet(null)}>
          <PlateSetup />
        </Sheet>
      )}

      {sheet === 'restore' && (
        <Sheet label="Restore from backup" onClose={() => setSheet(null)}>
          <Suspense fallback={<p role="status">Loading…</p>}>
            <RestoreBackup />
          </Suspense>
        </Sheet>
      )}

      {sheet === 'install' && (
        <Sheet label="Install app" onClose={() => setSheet(null)}>
          <InstallCard />
        </Sheet>
      )}

      {sheet === 'export' && (
        <Sheet label="Export my data" onClose={() => setSheet(null)}>
          <h2>Export my data</h2>
          <div className="stack">
            <button
              className="btn-secondary"
              onClick={() => void downloadBackup()}
            >
              JSON (everything, a full backup)
            </button>
            <button className="btn-secondary" onClick={async () => download(`retro-tracker-sets-${today()}.csv`, 'text/csv', await exportSetsCsv())}>
              CSV (one row per set, opens in Sheets/Excel)
            </button>
          </div>
        </Sheet>
      )}

      {/* Never a browser pop-up. Explicit consequence, export offer, typed confirmation. */}
      {sheet === 'delete' && (
        <Sheet label="Delete everything" onClose={() => setSheet(null)}>
          <h2>Delete everything?</h2>
          <p>
            This removes your programme and {sessions === 1 ? 'your 1 logged session' : `all ${sessions} logged sessions`} from this phone
            {syncConfigured && signedIn ? ', and your account from the cloud' : ''}. It can't be undone.
          </p>
          <button className="btn-secondary" onClick={() => setSheet('export')}>
            Export first
          </button>
          <label className="field">
            <span>Type DELETE to confirm</span>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <button
            className="btn-danger"
            disabled={confirmText.trim().toUpperCase() !== 'DELETE'}
            onClick={async () => {
              setDeleteError(null);
              // Decision 4: cloud first (rows + account), then this phone. Offline → stop and say so.
              if (signedIn && syncConfigured) {
                if (!navigator.onLine) {
                  setDeleteError('Connect to the internet to finish deleting your cloud data. Nothing has been deleted yet.');
                  return;
                }
                try {
                  await deleteMyAccount();
                  await signOut();
                } catch {
                  setDeleteError("Couldn't delete your cloud data. Nothing has been deleted yet. Try again.");
                  return;
                }
              }
              await deleteLocalData();
              switchAccount(GUEST);
              onDeleted();
            }}
          >
            Delete everything
          </button>
          {deleteError && (
            <p role="alert" style={{ color: 'var(--warn)', marginTop: 12 }}>
              {deleteError}
            </p>
          )}
        </Sheet>
      )}

      {/* Signing out asks whether to keep this account's data on the phone (default: remove, for shared phones). */}
      {sheet === 'signout' && (
        <Sheet label="Sign out" onClose={() => setSheet(null)}>
          <h2>Sign out</h2>
          <p>
            {pending ? `${pending} changes haven't synced yet. Sign out anyway? They stay on this phone until you sign back in.` : 'Your data is backed up.'}
          </p>
          <div className="stack">
            <button
              className="btn-secondary"
              onClick={async () => {
                await signOut();
                switchAccount(GUEST);
                window.location.reload();
              }}
            >
              Sign out, keep data on this phone
            </button>
            <button
              className="btn-secondary"
              disabled={pending > 0}
              onClick={async () => {
                await signOut();
                await deleteLocalData();
                switchAccount(GUEST);
                window.location.reload();
              }}
            >
              Sign out and remove from this phone
            </button>
          </div>
        </Sheet>
      )}

      {sheet === 'share' && (
        <Sheet label="Share with your PT" onClose={() => setSheet(null)}>
          <h2>Share with your PT</h2>
          <p className="muted">
            Your PT can see your completed workouts and update your programme. You can stop sharing any time.
          </p>
          <label className="field">
            <span>Your PT's share code (e.g. SAM-4K7)</span>
            <input value={shareCode} onChange={(e) => setShareCode(e.target.value)} autoCapitalize="characters" autoComplete="off" />
          </label>
          <button
            className="btn-primary compact"
            disabled={shareCode.trim().length < 6}
            onClick={async () => {
              try {
                await shareWithCoach(shareCode);
                setShareMsg('Shared. Your PT can now see your workouts.');
              } catch {
                setShareMsg("That code didn't work. Check it with your PT.");
              }
            }}
          >
            Share
          </button>
          {shareMsg && <p style={{ marginTop: 12 }}>{shareMsg}</p>}
        </Sheet>
      )}
    </>
  );
}
