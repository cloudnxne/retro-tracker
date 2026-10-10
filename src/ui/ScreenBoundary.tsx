import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { diagnosticsReport, errorSummary, logDiagnostic } from '../lib/diagnostics';

/**
 * A screen that fails shows what happened and how to recover, never a blank page (review note
 * 2026-10-08: ME rendered blank, which undermines trust in backup, import and settings).
 */
export class ScreenBoundary extends Component<{ name: string; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    void logDiagnostic('uncaught', `${this.props.name} screen: ${errorSummary(error)}`);
  }

  render() {
    if (this.state.error == null) return this.props.children;
    return (
      <main className="frame-screen" role="alert">
        <h1 className="display">This screen didn't load</h1>
        <p style={{ margin: '12px 0 24px' }}>
          Your workouts and settings are safe on this phone. Reloading usually fixes it, especially just after an update.
        </p>
        <div className="stack">
          <button className="btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="btn-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(await diagnosticsReport());
              } catch {
                /* clipboard blocked: nothing else to do from here */
              }
            }}
          >
            Copy diagnostics
          </button>
        </div>
        <p className="muted" style={{ marginTop: 16 }}>
          {errorSummary(this.state.error)}
        </p>
      </main>
    );
  }
}

const RELOADED_FLAG = 'sbs-chunk-reload';
const RESUME_TAB = 'sbs-resume-tab';

/**
 * React.lazy that survives a deploy: a screen's file can vanish from the server when a new version
 * ships while an old page is open. Retry once, then reload once to pick up the current version.
 * The flag stops a reload loop when the device is simply offline. `resumeTab` reopens the same tab
 * after that reload, so the user sees the screen (or its recovery message), not Today.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy
export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<{ default: T }>, resumeTab?: string) {
  return lazy(async () => {
    try {
      const mod = await load();
      clearReloadGuard();
      return mod;
    } catch {
      try {
        const mod = await load();
        clearReloadGuard();
        return mod;
      } catch (e) {
        let reloaded = false;
        try {
          reloaded = sessionStorage.getItem(RELOADED_FLAG) === '1';
          if (!reloaded) {
            sessionStorage.setItem(RELOADED_FLAG, '1');
            if (resumeTab) sessionStorage.setItem(RESUME_TAB, resumeTab);
          }
        } catch {
          reloaded = true;
        }
        void logDiagnostic('uncaught', `screen code failed to load${reloaded ? '' : ', reloading'}: ${errorSummary(e)}`);
        if (!reloaded) window.location.reload();
        throw e; // the ScreenBoundary shows the recovery message if the reload doesn't help
      }
    }
  });
}

/** The tab to reopen after an automatic reload, read once. */
export function takeResumeTab(): string | null {
  try {
    const t = sessionStorage.getItem(RESUME_TAB);
    sessionStorage.removeItem(RESUME_TAB);
    return t;
  } catch {
    return null;
  }
}

/** A screen loaded: a later failure may reload once again. */
function clearReloadGuard() {
  try {
    sessionStorage.removeItem(RELOADED_FLAG);
  } catch {
    /* storage blocked */
  }
}

/** Shown while a screen's code arrives: never an empty page. */
export function ScreenLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="scroll" aria-busy="true">
      <p className="muted" role="status" style={{ padding: 24 }}>
        {label}
      </p>
    </main>
  );
}
