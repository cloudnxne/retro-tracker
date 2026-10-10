#!/usr/bin/env node
/**
 * Migration: turn the bespoke PHP trackers' hardcoded DEFAULTS into programme JSON.
 *
 *   npm run migrate:php -- "path/to/php-trackers"
 *
 * Writes to ./migration-output (gitignored, it contains athletes' names and weights):
 *   <slug>.programme.json    normalised programme, ready to import into the app
 *   exercise-mapping.csv     every exercise name + guessed load type, for hand review
 *   report.md                everything that was flattened, guessed or skipped
 *
 * Only the helper functions (W/S) and data constants are evaluated, in an isolated
 * vm context with no access to require, process or the file system. The trackers'
 * DOM/UI code is never run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, guessLoadType, parseRange, parseRpe } from './lib.mjs';

const srcDir = process.argv[2] ?? 'path/to/php-trackers';
const outDir = path.resolve('migration-output');
fs.mkdirSync(outDir, { recursive: true });

const report = [];
const mappingRows = new Map();

for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.php'))) {
  const code = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const slug = (/\$slug\s*=\s*'([^']+)'/.exec(code)?.[1] ?? file.replace(/\.php$/, '')).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const { ctx, found } = evaluate(code);
  const D = ctx.DEFAULTS;
  if (!D || typeof D !== 'object') {
    report.push(`## ${file}\n- **Skipped:** no \`DEFAULTS\` programme object found (${JSON.stringify(found)}). This tracker uses a different format (e.g. a running or skill plan) and needs manual entry.\n`);
    continue;
  }
  const notes = [];
  const athlete = ctx.ATHLETE ?? {};
  const phaseList = athlete.phases ?? ctx.PHASES ?? Object.keys(D).map((id) => ({ id, label: ctx.PHASE_NAMES?.[id] ?? id }));
  const dayList = athlete.days ?? ctx.DAYS ?? null;
  const dayLabel = (id) => dayList?.find((d) => d.id === id)?.label ?? ctx.DAY_NAMES?.[id] ?? id;

  const blocks = [];
  for (const ph of phaseList) {
    const phase = D[ph.id];
    if (!phase) continue;
    const weeksMatch = /wk?s?\.?\s*(\d+)\s*[-–]\s*(\d+)/i.exec(ph.label ?? '');
    const weeks = weeksMatch ? +weeksMatch[2] - +weeksMatch[1] + 1 : 3;
    if (!weeksMatch) notes.push(`Block "${ph.label}": week count not stated, defaulted to **3**. Confirm.`);
    const days = [];
    for (const [dayId, day] of Object.entries(phase)) {
      if (!day?.exercises) continue;
      const exercises = [];
      day.exercises.forEach((ex, order) => {
        const sets = ex.sets ?? [];
        const warm = sets.filter((s) => s.label === 'W');
        const work = sets.filter((s) => s.label !== 'W');
        if (!work.length) return;
        const range = parseRange(work[0].reps) ?? { repMin: 8, repMax: 12 };
        if (!parseRange(work[0].reps)) notes.push(`${day.name} · ${ex.name}: reps "${work[0].reps}" not numeric, defaulted to 8–12.`);
        const kgs = work.map((s) => s.kg ?? null);
        const techs = [...new Set(work.map((s) => s.tech).filter(Boolean))];
        const superset = ex.ssRole || work.some((s) => s.ssRole);
        const sourceSetType = [...techs, ...(superset ? ['SUPERSET'] : [])].join('+') || null;
        if (sourceSetType) notes.push(`${day.name} · ${ex.name}: **${sourceSetType}** flattened to straight sets.`);
        const guessed = guessLoadType(ex.name);
        const loadType = guessed ?? 'machine';
        const exKey = ex.name.trim();
        const row = mappingRows.get(exKey) ?? { name: exKey, loadType, basis: !guessed ? 'DEFAULT - CHECK' : /weighted/i.test(exKey) ? 'name - WEIGHTED BW - CHECK' : 'name', athletes: new Set() };
        row.athletes.add(slug);
        mappingRows.set(exKey, row);
        const distinct = [...new Set(kgs.filter((k) => k != null))];
        exercises.push({
          order,
          sourceId: ex.id ?? null,
          name: exKey,
          loadType,
          restSec: ex.rest ?? 120,
          sets: work.length,
          repMin: range.repMin,
          repMax: range.repMax,
          targetRpe: parseRpe(work[0].rpe),
          prescribedKg: distinct.length ? Math.max(...distinct) : null,
          warmups: warm.map((w) => ({ kg: w.kg ?? null, reps: parseRange(w.reps)?.repMax ?? 5 })),
          cue: ex.cue ?? null,
          note: work.find((s) => s.note)?.note ?? null,
          sourceSetType,
        });
      });
      days.push({ sourceId: dayId, name: day.name ?? dayLabel(dayId), dayLabel: dayLabel(dayId), exercises });
    }
    blocks.push({ sourceId: ph.id, name: ph.label ?? ph.id, weeks, days });
  }

  const programme = {
    source: file,
    slug,
    athleteName: athlete.name ?? slug,
    name: athlete.subtitle ?? `${athlete.name ?? slug}'s programme`,
    // One PHP programme says it has no mandatory deloads; default the new engine's
    // every-4th-week deload on and let the coach turn it off per programme.
    deloadEvery: 4,
    blocks,
  };
  fs.writeFileSync(path.join(outDir, `${slug}.programme.json`), JSON.stringify(programme, null, 2));
  const exCount = blocks.reduce((n, b) => n + b.days.reduce((m, d) => m + d.exercises.length, 0), 0);
  report.push(
    `## ${file} → ${slug}.programme.json\n- ${blocks.length} blocks, ${exCount} exercise slots.\n` +
      (notes.length ? notes.map((n) => `- ${n}`).join('\n') : '- Nothing flattened or guessed.') +
      '\n',
  );
}

const csv = ['name,load_type,guess_basis,athletes,confirmed']
  .concat(
    [...mappingRows.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => `"${r.name.replace(/"/g, '""')}",${r.loadType},${r.basis},${[...r.athletes].join(' ')},`),
  )
  .join('\n');
fs.writeFileSync(path.join(outDir, 'exercise-mapping.csv'), csv);
fs.writeFileSync(
  path.join(outDir, 'report.md'),
  `# PHP migration report (${new Date().toISOString().slice(0, 10)})\n\nReview \`exercise-mapping.csv\` (fill the "confirmed" column), then import each programme JSON from ME → Import programme.\n\n${report.join('\n')}`,
);
console.log(`Wrote ${fs.readdirSync(outDir).length} files to ${outDir}`);
