import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSetting } from '../db/repo';
import { buzz, restOverChime } from './sound';
import * as rt from './restTimer';

/**
 * React wiring for the rest timer. The rules (end timestamp, chime-once, +30s) live in
 * restTimer.ts and are unit-tested; this hook only ticks, persists and plays sounds.
 */
export function useRestTimer(sessionId: string) {
  const timer = useLiveQuery(() => db().timers.get('rest'), []);
  const [now, setNow] = useState(() => Date.now());
  const chimedFor = useRef<number | null>(null);
  const [justFinished, setJustFinished] = useState(false);

  const active = timer && timer.sessionId === sessionId ? timer : undefined;

  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active]);

  useEffect(() => {
    if (!active || !rt.shouldChime(active, chimedFor.current, document.visibilityState === 'visible', now)) return;
    chimedFor.current = active.endsAt;
    void getSetting('soundOn', true).then((on) => on && restOverChime());
    buzz();
    setJustFinished(true);
  }, [active, now]);

  useEffect(() => {
    if (!justFinished) return;
    const t = window.setTimeout(() => setJustFinished(false), 3000);
    return () => window.clearTimeout(t);
  }, [justFinished]);

  const start = useCallback(
    (sec: number) => db().timers.put({ key: 'rest', sessionId, ...rt.start(sec, Date.now()) }),
    [sessionId],
  );
  const add = useCallback(async (sec: number) => {
    const t = await db().timers.get('rest');
    if (t) await db().timers.put({ ...t, ...rt.addTime(t, sec, Date.now()) });
  }, []);
  const skip = useCallback(() => db().timers.delete('rest'), []);

  return {
    running: !!active,
    remainingMs: active ? rt.remainingMs(active, now) : 0,
    progress: active ? rt.progress(active, now) : 0,
    totalSec: active?.totalSec ?? 0,
    endsAt: active?.endsAt ?? null,
    justFinished,
    start,
    add,
    skip,
  };
}

export const fmtClock = (ms: number) => {
  const s = Math.round(Math.abs(ms) / 1000);
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
