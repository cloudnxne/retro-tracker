import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/800-italic.css';
import './styles/app.css';
import { captureInstallPrompt } from './lib/install';
import { App } from './App';
import { db, getSetting, migrateLegacyDb, setSetting } from './db/repo';
import { APP_VERSION, errorSummary } from './lib/diagnostics';
import { installGlobalWriteErrorHandler } from './lib/safeWrite';
import { startUpdateWatcher } from './lib/appUpdate';
import { startSyncLoop } from './sync/runner';

captureInstallPrompt();
installGlobalWriteErrorHandler();

// Ask the browser not to evict saved sets. The result drives the "Add to Home Screen" banner.
void (async () => {
  if (await getSetting('persistAsked', false)) return;
  await setSetting('persistAsked', true);
  const granted = (await navigator.storage?.persist?.().catch(() => false)) ?? false;
  await setSetting('persistGranted', granted);
})();

// Pre-account builds kept everything in one "retro-tracker" DB: move it to the guest DB first.
await migrateLegacyDb().catch((e) => console.error('[migrateLegacyDb]', e));

/**
 * Error registry: if storage can't open (a failed version upgrade, blocked storage), say so plainly
 * instead of a blank screen. The data is still on the phone; clearing site data would destroy it.
 */
function StorageError({ reason }: { reason: string }) {
  const text = `Retro Tracker ${APP_VERSION} could not open storage: ${reason}`;
  return (
    <main className="frame-screen">
      <h1 className="display">Can't open your data</h1>
      <p style={{ margin: '12px 0' }}>
        Your workouts are still saved on this phone. <strong>Don't clear browser or site data.</strong> Close the app and
        open it again. If this keeps happening, copy the message below and send it to us.
      </p>
      <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>
      <button className="btn-secondary" onClick={() => void navigator.clipboard?.writeText(text)}>
        Copy message
      </button>
    </main>
  );
}

const root = createRoot(document.getElementById('root')!);
let storageError: string | null = null;
await db()
  .open()
  .catch((e) => {
    storageError = errorSummary(e);
    console.error('[storage] open failed', e);
  });

if (storageError) {
  root.render(<StorageError reason={storageError} />);
} else {
  startSyncLoop();
  startUpdateWatcher();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
