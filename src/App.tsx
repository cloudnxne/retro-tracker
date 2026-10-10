import { Suspense, useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getSetting, isSignedIn, setSetting, startSession, today, type SessionSummary } from './db/repo';
import { SignIn } from './features/auth/SignIn';
import { syncConfigured } from './sync/supabase';
import { SessionScreen } from './features/session/SessionScreen';
import { CompleteScreen } from './features/session/CompleteScreen';
import { ReadyScreen } from './features/today/ReadyScreen';
import { Finished, NoProgramme } from './features/today/EmptyStates';
// ME isn't needed to log a set: loaded on first visit to keep the gym-time startup small (bundle size budget).
const loadMe = () => import('./features/me/MeScreen').then((m) => ({ default: m.MeScreen }));
const MeScreen = lazyScreen(loadMe, 'me');
import { Consent, Welcome } from './features/onboarding/Onboarding';
import { useThemeSync } from './lib/theme';
import { WriteErrorToast } from './ui/WriteErrorToast';
import { lazyScreen, ScreenBoundary, ScreenLoading, takeResumeTab } from './ui/ScreenBoundary';

type Tab = 'today' | 'me';
const DELETED_FLAG = 'rt-deleted';

export function App() {
  return (
    <>
      <Screens />
      <WriteErrorToast />
    </>
  );
}

function Screens() {
  useThemeSync();
  const consent = useLiveQuery(() => getSetting<number | null>('consentAt', null), []);
  const welcome = useLiveQuery(() => getSetting('welcomePending', false), []);
  const skippedSignIn = useLiveQuery(() => getSetting('signInSkipped', false), []);
  const state = useLiveQuery(today, []);
  // After the automatic reload for a screen's missing code, reopen that screen, not Today.
  const [tab, setTab] = useState<Tab>(() => (takeResumeTab() === 'me' ? 'me' : 'today'));
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onFinished = useCallback((s: SessionSummary) => setSummary(s), []);

  // Fetch ME's code in the background so the tab opens instantly (and works offline) instead of
  // downloading on first tap.
  useEffect(() => {
    const idle = (cb: () => void) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(cb) : setTimeout(cb, 1500));
    idle(() => void loadMe().catch(() => {}));
  }, []);

  // After "Delete everything" the page reloads onto the consent screen with a confirmation toast.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(DELETED_FLAG)) {
        sessionStorage.removeItem(DELETED_FLAG);
        setNotice("Everything's been deleted.");
      }
    } catch {
      /* storage blocked */
    }
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const toast = notice && (
    <div className="toast solo" role="status">
      {notice}
    </div>
  );

  if (consent === undefined || state === undefined || skippedSignIn === undefined) return <div className="app" aria-busy="true" />;
  if (!consent) {
    return (
      <div className="app">
        <Consent />
        {toast}
      </div>
    );
  }
  // Offer sign-in once after consent when cloud sync is set up. The app reloads onto the account DB.
  if (syncConfigured && !isSignedIn() && !skippedSignIn) {
    return (
      <div className="app">
        <SignIn onDone={() => window.location.reload()} onSkip={() => void setSetting('signInSkipped', true)} />
      </div>
    );
  }
  if (summary) {
    return (
      <div className="app">
        <CompleteScreen summary={summary} onDone={() => setSummary(null)} />
      </div>
    );
  }
  if (welcome && state.kind === 'ready') {
    return (
      <div className="app">
        <Welcome onStart={() => void startSession(state)} />
      </div>
    );
  }
  // No tab bar during a session.
  if (state.kind === 'in-session') {
    return (
      <ScreenBoundary name="Session">
        <SessionScreen key={state.session.id} sessionId={state.session.id} onFinished={onFinished} />
      </ScreenBoundary>
    );
  }

  return (
    <div className="app tabbed">
      <ScreenBoundary key={tab} name={tab === 'me' ? 'Me' : 'Today'}>
      {tab === 'me' ? (
        <Suspense fallback={<ScreenLoading />}>
        <MeScreen
          onDeleted={() => {
            try {
              sessionStorage.setItem(DELETED_FLAG, '1');
            } catch {
              /* storage blocked: the reload still lands on consent */
            }
            window.location.reload();
          }}
        />
        </Suspense>
      ) : state.kind === 'ready' ? (
        <ReadyScreen state={state} />
      ) : state.kind === 'finished' ? (
        <Finished state={state} />
      ) : (
        <NoProgramme />
      )}
      </ScreenBoundary>
      <nav className="tabs" aria-label="Main">
        <button aria-current={tab === 'today' ? 'page' : undefined} onClick={() => setTab('today')}>
          Today
        </button>
        <button aria-current={tab === 'me' ? 'page' : undefined} onClick={() => setTab('me')}>
          Me
        </button>
      </nav>
      {toast}
    </div>
  );
}
