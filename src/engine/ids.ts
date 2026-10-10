/**
 * Exercise IDs are derived from the normalised name, so every device and every
 * PT programme produces the same ID for "Bench Press (Barbell)" and nothing ever needs merging.
 *
 * Known shortcut: different exercises that share a name collide and aliases
 * ("BB Bench") are not understood. Upgrade to a curated exercise library with stable IDs +
 * aliases when the PT programme builder ships or the first collision is reported.
 */

/** Fixed namespace for this app's exercise IDs. Never change it: every stored ID depends on it. */
export const EXERCISE_NAMESPACE = '6f1c2b8e-3d4a-5b6c-8d7e-9f0a1b2c3d4e';

/** "  Bench-Press (Barbell) " → "bench press barbell". */
export function normaliseExerciseName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function uuidBytes(uuid: string): Uint8Array {
  const h = uuid.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}

/** RFC 4122 version-5 UUID (SHA-1 of namespace + name). */
export async function uuidv5(name: string, namespace = EXERCISE_NAMESPACE): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidBytes(namespace));
  input.set(nameBytes, 16);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = hex(digest);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const exerciseIdFor = (name: string) => uuidv5(normaliseExerciseName(name));
