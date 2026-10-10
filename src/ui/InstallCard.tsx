import { setSetting } from '../db/repo';
import { useInstallMode } from '../lib/install';

/**
 * "Put it on your Home Screen". Android/Chrome gets a real INSTALL button,
 * iPhone gets the 3-step Share → Add to Home Screen guide, installed apps never see it.
 * `dismissible` = the one-time card on the first Session Complete; ME shows it permanently.
 */
export function InstallCard({ dismissible = false, onDone }: { dismissible?: boolean; onDone?: () => void }) {
  const { mode, install } = useInstallMode();
  if (mode === 'installed') {
    return dismissible ? null : <p className="muted">Installed. You're running the app from your Home Screen.</p>;
  }
  const dismiss = async () => {
    await setSetting('installDismissed', true);
    onDone?.();
  };
  return (
    <section className="install-card" aria-label="Add to Home Screen">
      <h2>Put it on your Home Screen</h2>
      <p className="muted">Full screen, one tap to open, works offline.</p>
      {mode === 'prompt' && (
        <div className="row">
          <button
            className="btn-primary compact"
            onClick={async () => {
              if (await install()) await dismiss();
            }}
          >
            Install
          </button>
          {dismissible && (
            <button className="btn-secondary" onClick={dismiss}>
              Not now
            </button>
          )}
        </div>
      )}
      {mode === 'ios-guide' && (
        <>
          <ol>
            <li>
              Tap the <b>Share</b> button <span aria-hidden="true">(□↑)</span> in Safari's toolbar.
            </li>
            <li>
              Scroll and tap <b>Add to Home Screen</b>.
            </li>
            <li>
              Tap <b>Add</b>.
            </li>
          </ol>
          {dismissible && (
            <button className="btn-secondary" onClick={dismiss}>
              Got it
            </button>
          )}
        </>
      )}
      {mode === 'browser-menu' && (
        <>
          <p className="muted" style={{ marginTop: 8 }}>
            Open your browser's menu and choose <b>Install app</b> or <b>Add to Home Screen</b>.
          </p>
          {dismissible && (
            <button className="btn-secondary" onClick={dismiss}>
              Got it
            </button>
          )}
        </>
      )}
    </section>
  );
}
