import { importProgramme, restartProgramme, type TodayState } from '../../db/repo';
import { STARTER } from '../../data/starter';
import { ImportButton } from '../me/ImportButton';

/** No active programme. */
export function NoProgramme() {
  return (
    <main className="frame-screen">
      <div className="sun small" aria-hidden="true" />
      <h1 className="display">No programme yet</h1>
      <p className="muted" style={{ margin: '12px 0 32px' }}>
        Your coach hasn't assigned one yet.
      </p>
      <div className="stack">
        <button className="btn-primary" onClick={() => importProgramme(STARTER)}>
          Use a starter programme
        </button>
        <ImportButton />
      </div>
    </main>
  );
}

/** Programme finished. A celebration screen, so the half-sun comes up. */
export function Finished({ state }: { state: Extract<TodayState, { kind: 'finished' }> }) {
  const again = () => restartProgramme(state.ap);
  return (
    <main className="frame-screen pr-moment">
      <div className="sun" aria-hidden="true" />
      <h1 className="display">Block complete.</h1>
      <p className="muted" style={{ margin: '12px 0 32px' }}>
        Every week done. Run it again with your new numbers, or pick another.
      </p>
      <div className="stack">
        <button className="btn-primary" onClick={again}>
          Run it again (+ progression)
        </button>
        <ImportButton label="Pick another programme" />
      </div>
    </main>
  );
}
