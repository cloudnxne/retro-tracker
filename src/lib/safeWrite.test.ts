import { describe, expect, it, vi } from 'vitest';
import { describeWriteError, onWriteFailure, safeWrite, type WriteFailure } from './safeWrite';

describe('safeWrite', () => {
  it('returns true and clears any shown failure on success', async () => {
    const seen: (WriteFailure | null)[] = [];
    const off = onWriteFailure((f) => seen.push(f));
    expect(await safeWrite('Set 2', async () => {})).toBe(true);
    expect(seen).toEqual([null]);
    off();
  });

  it('returns false and reports a named, human failure when the write throws', async () => {
    const seen: (WriteFailure | null)[] = [];
    const off = onWriteFailure((f) => seen.push(f));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    expect(await safeWrite('Set 2', async () => Promise.reject(quota))).toBe(false);
    expect(seen[0]).toMatchObject({ label: 'Set 2', message: 'phone storage is full' });
    off();
  });

  it('TRY AGAIN re-runs the same action', async () => {
    let calls = 0;
    let failure: WriteFailure | null = null;
    const off = onWriteFailure((f) => (failure = f ?? failure));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('flaky');
    };
    expect(await safeWrite('Set 2', fn)).toBe(false);
    expect(await failure!.retry()).toBe(true);
    expect(calls).toBe(2);
    off();
  });

  it('describes blocked storage (private browsing)', () => {
    expect(describeWriteError({ name: 'InvalidStateError' })).toMatch(/blocked/);
    expect(describeWriteError({ name: 'DatabaseClosedError', inner: { name: 'QuotaExceededError' } })).toBe('phone storage is full');
    expect(describeWriteError(new Error('x'))).toBe('something went wrong');
  });
});
