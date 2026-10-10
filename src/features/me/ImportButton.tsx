import { useRef, useState } from 'react';
import { importProgramme } from '../../db/repo';

/** Import a programme JSON produced by `npm run migrate:php` (or exported from another device). */
export function ImportButton({ label = 'Import programme file' }: { label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button className="btn-secondary" onClick={() => input.current?.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            setError(null);
            await importProgramme(JSON.parse(await file.text()));
          } catch (err) {
            setError(err instanceof Error ? err.message : 'That file could not be read.');
          }
        }}
      />
      {error && (
        <p role="alert" style={{ color: 'var(--warn)' }}>
          {error}
        </p>
      )}
    </>
  );
}
