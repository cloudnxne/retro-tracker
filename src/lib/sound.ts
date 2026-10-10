/**
 * Synthesised 80s arcade sounds. Generated with Web Audio, so nothing to download
 * and they work offline. iOS silent mode can mute these; every sound has a visual +
 * vibration equivalent, so nothing depends on audio.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from any user tap early on, so iOS allows sound later. */
export function unlockAudio() {
  audio();
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', gain = 0.12) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = a.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export function restOverChime() {
  tone(880, 0, 0.18);
  tone(1318.5, 0.16, 0.5);
}

/** Short, satisfying "set done" blip (noise on completed set). */
export function setDoneSound() {
  tone(659.25, 0, 0.07, 'square', 0.09);
  tone(987.77, 0.06, 0.12, 'square', 0.09);
}

export function prFanfare() {
  tone(523.25, 0, 0.16, 'sawtooth', 0.08);
  tone(659.25, 0.15, 0.16, 'sawtooth', 0.08);
  tone(783.99, 0.3, 0.16, 'sawtooth', 0.08);
  tone(1046.5, 0.45, 0.6, 'square', 0.1);
}

export function buzz(pattern: number[] = [200, 100, 200]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
