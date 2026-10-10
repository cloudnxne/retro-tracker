import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getSetting, setSetting, today } from '../../db/repo';
import { formatWeight } from '../../engine/copy';

/** Consent: one screen, plain language. Nothing is stored until they agree. */
export function Consent() {
  const [agreed, setAgreed] = useState(false);
  const [declined, setDeclined] = useState(false);
  return (
    <main className="frame-screen">
      <div className="sun small" aria-hidden="true" />
      <h1 className="display">Retro Tracker</h1>
      <p style={{ margin: '24px 0 8px' }}>
        We store your training, bodyweight and food logs to track your progress. Only you (and a coach you invite) can
        see them.
      </p>
      <p className="muted">
        Right now everything stays on this phone. When cloud sync is switched on, it's stored in the EU and you can
        export or delete it any time from ME.
      </p>
      <label className="check" style={{ margin: '16px 0' }}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I agree</span>
      </label>
      <div className="stack">
        <button className="btn-primary" disabled={!agreed} onClick={() => setSetting('consentAt', Date.now())}>
          Continue
        </button>
        <button className="btn-link" onClick={() => setDeclined(true)}>
          I don't agree
        </button>
      </div>
      {declined && (
        <p role="alert" style={{ marginTop: 12 }}>
          We can't track anything without this. Nothing has been saved.
        </p>
      )}
    </main>
  );
}

/** Welcome back: shown once after a migrated programme is imported. */
export function Welcome({ onStart }: { onStart: () => void }) {
  const name = useLiveQuery(() => getSetting<string>('athleteName', ''), []);
  const t = useLiveQuery(today, []);
  const first = t?.kind === 'ready' ? t.plan[0] : undefined;
  const dismiss = () => setSetting('welcomePending', false);
  return (
    <main className="frame-screen">
      <div className="sun small" aria-hidden="true" />
      <h1 className="display">
        Welcome back{name ? ',' : ''}
        <br />
        {name}
      </h1>
      <p style={{ margin: '24px 0 8px' }}>Your programme came with you.</p>
      {t?.kind === 'ready' && (
        <p className="muted">
          Today: {t.dayName}
          {first?.suggestedKg != null ? ` · ${first.name} ${formatWeight(first.suggestedKg)}` : ''}
        </p>
      )}
      <div className="stack" style={{ marginTop: 32 }}>
        <button
          className="btn-primary"
          onClick={async () => {
            await dismiss();
            onStart();
          }}
        >
          Start today's session
        </button>
        <button className="btn-link" onClick={dismiss}>
          Look around first
        </button>
      </div>
    </main>
  );
}
