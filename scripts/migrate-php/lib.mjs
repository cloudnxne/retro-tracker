/** Pure helpers for extract.mjs, split out so they can be unit-tested. */
import vm from 'node:vm';

/** Find `const NAME=` and return the full declaration, balancing brackets and skipping strings. */
export function extractConst(code, name) {
  const m = new RegExp(`(^|[\\s;])const\\s+${name}\\s*=`, 'm').exec(code);
  if (!m) return null;
  const start = m.index + m[1].length;
  let i = m.index + m[0].length;
  let depth = 0;
  let quote = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && code[i + 1] === '/') i = code.indexOf('\n', i) - 1;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if ((c === ';' || c === '\n') && depth === 0) {
      // An arrow function body can continue past a newline only while brackets are open.
      const before = code.slice(start, i).trim();
      if (before.endsWith('=>') || before.endsWith('=')) continue;
      break;
    }
  }
  return code.slice(start, i) + ';';
}

/** Every top-level UPPERCASE const (data and set-builder helpers like W, S, P, ONE_RM), in file order. */
export function dataDecls(code) {
  const names = [];
  for (const m of code.matchAll(/(?:^|[\s;])const\s+([A-Z][A-Z0-9_]*)\s*=/gm)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function evaluate(code) {
  const ctx = vm.createContext(Object.create(null));
  const found = {};
  for (const name of dataDecls(code)) {
    const decl = extractConst(code, name);
    if (!decl) continue;
    try {
      vm.runInContext(decl.replace(/^const /, 'var '), ctx, { timeout: 1000 });
      found[name] = true;
    } catch (e) {
      found[name] = `error: ${e.message}`;
    }
  }
  return { ctx, found };
}

export const parseRange = (reps) => {
  const s = String(reps ?? '').trim();
  const r = /(\d+)\s*[-–]\s*(\d+)/.exec(s);
  if (r) return { repMin: +r[1], repMax: +r[2] };
  const n = /(\d+)/.exec(s);
  if (n) return { repMin: +n[1], repMax: +n[1] };
  return null;
};

export const parseRpe = (rpe) => {
  if (rpe == null || rpe === '') return null;
  const nums = String(rpe).match(/\d+(\.\d+)?/g);
  return nums ? Math.max(...nums.map(Number)) : null;
};

/** Guess from the NAME only: a missing weight just means "RPE-based", not bodyweight. */
export function guessLoadType(name) {
  const n = name.toLowerCase();
  if (/\b(db|dumbbell)/.test(n)) return 'dumbbell';
  if (/(barbell|\bbb\b|squat|bench|deadlift|ohp|overhead press|row \(barbell|rdl|good morning|hip thrust)/.test(n) && !/(machine|smith|hack|goblet|split squat|bulgarian)/.test(n)) return 'barbell';
  if (/(machine|cable|pulldown|leg press|smith|hack|extension|curl \(machine|pec deck|lateral raise machine|leg curl|abductor|adductor|kickback)/.test(n)) return 'machine';
  if (/(pull-?up|chin-?up|dip|push-?up|plank|hang|inverted row|bodyweight|nordic|glute bridge \(bw)/.test(n)) return 'bodyweight';
  return null;
}
