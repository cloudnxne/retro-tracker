import { useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { formatWeight } from '../engine/copy';
import { NumberInput } from './NumberInput';

/**
 * 64px −/+ step by the loadable increment (hold to repeat at 8/s). The number itself is a field:
 * the phone's number keyboard opens straight away so a weight can be typed (this replaced a custom keypad). Enter or SAVE saves.
 */
export function EditSheet({
  title,
  value,
  step,
  min = 0,
  unit,
  decimals = true,
  onSave,
  onClose,
}: {
  title: string;
  value: number | null;
  step: number;
  min?: number;
  unit?: string;
  decimals?: boolean;
  onSave: (v: number) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState<number>(value ?? min);
  const [typed, setTyped] = useState<string | null>(null);
  const repeat = useRef<number | null>(null);
  const current = typed != null ? Number(typed || '0') : v;

  const bump = (dir: 1 | -1) => {
    setTyped(null);
    setV((x) => Math.max(min, Math.round((x + dir * step) * 100) / 100));
  };
  const hold = (dir: 1 | -1) => {
    bump(dir);
    let n = 0;
    repeat.current = window.setInterval(() => {
      if (++n > 3) bump(dir); // short delay before repeating
    }, 125);
  };
  const release = () => {
    if (repeat.current) window.clearInterval(repeat.current);
    repeat.current = null;
  };
  useEffect(() => release, []);

  const save = () => onSave(Math.max(min, current));

  return (
    <Sheet label={title} onClose={save}>
      <h2>{title}</h2>
      <div className="stepper">
        <button
          aria-label={`Decrease by ${step}`}
          onPointerDown={() => hold(-1)}
          onPointerUp={release}
          onPointerLeave={release}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && bump(-1)}
        >
          −
        </button>
        <div className="stepper-value">
          <NumberInput label={title} display={formatWeight(v)} typed={typed} onType={setTyped} onEnter={save} decimals={decimals} autoFocus />
          {unit && <small className="muted">{unit}</small>}
        </div>
        <button
          aria-label={`Increase by ${step}`}
          onPointerDown={() => hold(1)}
          onPointerUp={release}
          onPointerLeave={release}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && bump(1)}
        >
          +
        </button>
      </div>
      <div className="sheet-actions">
        <button className="btn-secondary" onClick={onClose}>
          CANCEL
        </button>
        <button className="btn-primary" style={{ minHeight: 48, fontSize: 22 }} onClick={save}>
          SAVE
        </button>
      </div>
    </Sheet>
  );
}
