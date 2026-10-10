import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { answerWeightIfAsked, doneButton, onboard, startSession } from './helpers';

async function noSeriousA11yIssues(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const openMe = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Me' }).click();

test('1. first-time weight: DONE waits for a weight', async ({ page }) => {
  await startSession(page);
  // The starter has no weights, so the first working set asks.
  await expect(page.getByText('What will you lift today?')).toBeVisible();
  await expect(doneButton(page)).toBeDisabled();
  await answerWeightIfAsked(page);
  await expect(doneButton(page)).toBeEnabled();
});

test('2. full set: DONE, rest timer, RPE, UNDO', async ({ page }) => {
  await startSession(page);
  await answerWeightIfAsked(page);
  await expect(doneButton(page)).toBeEnabled();
  const firstSet = await doneButton(page).getAttribute('aria-label');
  await doneButton(page).click();

  const toast = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'UNDO' }) });
  await expect(toast).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 30 seconds' })).toBeVisible();
  const rpe = page.getByRole('group', { name: /RPE, optional/ });
  await expect(rpe).toBeVisible();
  await expect(doneButton(page)).not.toHaveAttribute('aria-label', firstSet!);

  await toast.getByRole('button', { name: 'UNDO' }).click();
  await expect(doneButton(page)).toHaveAttribute('aria-label', firstSet!);
});

test('3. set list: edit a done set', async ({ page }) => {
  await startSession(page);
  await answerWeightIfAsked(page);
  await doneButton(page).click();

  await page.getByRole('button', { name: /^All sets for/ }).click();
  const list = page.getByRole('dialog');
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: /for \d+ reps/ }).first().click();
  const edit = page.getByRole('dialog', { name: 'Edit logged set' });
  await expect(edit).toBeVisible();
  await edit.getByRole('button', { name: 'Mark as not done' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByText('What will you lift today?').or(doneButton(page))).toBeVisible();
});

test('4. a bad programme file shows a named error and imports nothing', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('I agree').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const bad = {
    name: 'Broken',
    deloadEvery: 4,
    blocks: [{ name: 'B', weeks: 3, days: [{ name: 'D', exercises: [
      { name: 'Squat', loadType: 'barbell', restSec: 120, sets: 99, repMin: 5, repMax: 5, targetRpe: 8, prescribedKg: null, warmups: [] },
    ] }] }],
  };
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.getByRole('alert')).toContainText(/sets/i);
  await expect(page.getByRole('heading', { name: 'No programme yet' })).toBeVisible();
});

test('5. delete everything returns to consent', async ({ page }) => {
  await onboard(page);
  await openMe(page);
  await page.getByRole('button', { name: 'Delete everything' }).click();
  const sheet = page.getByRole('dialog', { name: 'Delete everything' });
  const confirm = sheet.getByRole('button', { name: 'Delete everything' });
  await expect(confirm).toBeDisabled();
  await sheet.getByLabel('Type DELETE to confirm').fill('delete');
  await confirm.click();
  await expect(page.getByLabel('I agree')).toBeVisible();
});

test('6. theme switch changes palette without moving the layout', async ({ page }) => {
  await onboard(page);
  await openMe(page);
  const theme = page.getByRole('group', { name: 'Theme' });
  const nav = page.getByRole('navigation', { name: 'Main' });

  await theme.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const boxDark = await nav.boundingBox();

  await theme.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const boxLight = await nav.boundingBox();

  expect(bgLight).not.toBe(bgDark);
  expect(boxLight).toEqual(boxDark);

  await page.reload(); // the choice survives a reload and is applied before first paint
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('7. accessibility: consent, ready, session and ME screens', async ({ page }) => {
  await page.goto('/');
  await noSeriousA11yIssues(page);
  await page.getByLabel('I agree').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use a starter programme' }).click();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  await noSeriousA11yIssues(page);
  await openMe(page);
  await noSeriousA11yIssues(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('button', { name: /^Log |All sets logged/ })).toBeVisible();
  await noSeriousA11yIssues(page);
});

test('8. import Strong history: preview, named row errors, import, LAST TIME uses it', async ({ page }) => {
  await onboard(page);
  await openMe(page);
  await page.getByRole('button', { name: 'Import past workouts' }).click();
  const sheet = page.getByRole('dialog', { name: 'Import history' });
  await sheet.locator('input[type=file]').setInputFiles('src/import/fixtures/strong-sample.csv');

  await expect(sheet.getByText('2 workouts', { exact: true })).toBeVisible();
  await expect(sheet.getByText('1 rest timer, 1 note, 1 cardio entry', { exact: false })).toBeVisible();
  await expect(sheet.getByText('Row 14: date "2024-13-40 10:00:00" not recognised')).toBeVisible();
  const importBtn = sheet.getByRole('button', { name: 'Import 2 workouts' });
  await expect(importBtn).toBeDisabled(); // row errors need an explicit "import the rest"
  await sheet.getByLabel('Import the rest').check();
  await noSeriousA11yIssues(page);
  await importBtn.click();

  await expect(page.getByRole('heading', { name: 'History imported' })).toBeVisible();
  await expect(page.getByText('2 workouts and 9 sets are now in the app')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // The starter's squat now starts from the imported top set instead of asking for a weight.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('What will you lift today?')).toBeHidden();
  await expect(page.getByRole('button', { name: /from your imported history/ })).toBeVisible();
});

test('9. a non-Strong file is refused with a clear message', async ({ page }) => {
  await onboard(page);
  await openMe(page);
  await page.getByRole('button', { name: 'Import past workouts' }).click();
  const sheet = page.getByRole('dialog', { name: 'Import history' });
  await sheet.locator('input[type=file]').setInputFiles({ name: 'hevy.csv', mimeType: 'text/csv', buffer: Buffer.from('"title","start_time","exercise_title","set_type","weight_kg"\n') });
  await expect(sheet.getByRole('alert')).toContainText('Hevy import is coming');
  await sheet.locator('input[type=file]').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('date,exercise,kg\n2024-01-01,Squat,100\n') });
  await expect(sheet.getByRole('alert')).toContainText("This isn't a Strong export");
});

test('10. backup → delete everything → restore brings the data back', async ({ page }) => {
  await startSession(page);
  await answerWeightIfAsked(page);
  await doneButton(page).click();
  await page.getByRole('button', { name: 'Session menu' }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await page.getByRole('dialog', { name: 'Finish session' }).getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await openMe(page);
  await expect(page.getByText('No backup saved yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Export my data' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /JSON/ }).click();
  const backupPath = await (await downloadPromise).path();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Last backup:/)).toBeVisible();

  await page.getByRole('button', { name: 'Delete everything' }).click();
  const del = page.getByRole('dialog', { name: 'Delete everything' });
  await del.getByLabel('Type DELETE to confirm').fill('delete');
  await del.getByRole('button', { name: 'Delete everything' }).click();

  await page.getByLabel('I agree').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use a starter programme' }).click();
  await openMe(page);
  await page.getByRole('button', { name: 'Restore from backup' }).click();
  const sheet = page.getByRole('dialog', { name: 'Restore from backup' });
  await sheet.locator('input[type=file]').setInputFiles(backupPath);
  await expect(sheet.getByText('1 workout, ', { exact: false })).toBeVisible();
  await expect(sheet.getByText('This replaces everything on this phone')).toBeVisible();
  await sheet.getByRole('button', { name: 'Replace everything with this backup' }).click();

  // After the reload the logged workout is back (TODAY has moved on to the next day).
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Day B/ })).toBeVisible();
});

test('11. import tracker logs: several JSON files at once, templates ignored, re-saves merged', async ({ page }) => {
  const set = (label: string, kg: number, reps: number, completed = true) => ({ label, targetKg: kg, targetReps: String(reps), loggedKg: kg, loggedReps: reps, completed });
  const log = (date: string, time: string, day: string, kg: number) => ({
    date, completedAt: `${date}T${time}.000Z`, phase: 'ph1', day, sessionName: `${day} - Squat`,
    exercises: [{ name: 'Squat (Barbell)', sets: [set('W', 60, 5), set('1', kg, 6), set('2', kg, 6)] }],
  });
  const file = (name: string, json: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });

  await onboard(page);
  await openMe(page);
  await page.getByRole('button', { name: 'Import past workouts' }).click();
  const sheet = page.getByRole('dialog', { name: 'Import history' });
  await sheet.locator('input[type=file]').setInputFiles([
    file('a.json', log('2024-02-05', '07:00:00', 'mon', 100)),
    file('a-resave.json', log('2024-02-05', '07:05:00', 'mon', 102.5)),
    file('b.json', log('2024-02-12', '07:00:00', 'mon', 105)),
    file('ph1_mon.json', { phase: 'ph1', day: 'mon', exercises: [] }),
  ]);
  await expect(sheet.getByText('From your tracker logs')).toBeVisible();
  await expect(sheet.getByText('2 workouts', { exact: true })).toBeVisible();
  await expect(sheet.getByText('1 workout saved twice: the latest save is kept.')).toBeVisible();
  await expect(sheet.getByText('1 programme template ignored (not workouts).')).toBeVisible();
  await sheet.getByRole('button', { name: 'Import 2 workouts' }).click();
  await expect(page.getByText('2 workouts and 6 sets are now in the app')).toBeVisible();
});

test('12. FUEL check-in: three taps above Start, saved, editable', async ({ page }) => {
  await onboard(page);
  const row = page.getByRole('button', { name: /FUEL/ });
  await expect(row).toContainText(/Log (yesterday|today)'s food/);
  await row.click();
  const sheet = page.getByRole('dialog', { name: 'FUEL check-in' });
  await expect(sheet.getByText('Log your bodyweight once to set a target')).toBeVisible();
  await sheet.getByRole('group', { name: 'Protein against your target' }).getByRole('button', { name: 'Hit' }).click();
  await sheet.getByRole('group', { name: 'Food overall' }).getByRole('button', { name: 'Normal' }).click();
  await sheet.getByRole('button', { name: 'Same as last time' }).click(); // first time: starts at 80 kg
  await sheet.getByRole('button', { name: 'Increase by 0.1' }).click();
  await noSeriousA11yIssues(page);
  await sheet.getByRole('button', { name: 'SAVE' }).click();
  await expect(sheet).toBeHidden();
  await expect(row).toContainText('protein hit · normal day · 80.1 kg');

  // Reopen: saved values show, the target now exists, and a change sticks.
  await row.click();
  await expect(sheet.getByText('Target ≈ 130 g (1.6 g/kg)')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Hit' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Under' }).click();
  await sheet.getByRole('button', { name: 'SAVE' }).click();
  await expect(row).toContainText('protein under');
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
});

const notesProgramme = {
  name: 'Notes test',
  deloadEvery: 0,
  blocks: [{ name: 'B', weeks: 2, days: [{ name: 'Mon', exercises: [
    { name: 'Squat (Barbell)', loadType: 'barbell', restSec: 60, sets: 2, repMin: 6, repMax: 6, targetRpe: null, prescribedKg: 100, warmups: [],
      cue: 'Final set is AMRAP: log every rep you get.', sourceSetType: 'AMRAP last set' },
    { name: 'Pause Squat', loadType: 'barbell', restSec: 60, sets: 2, repMin: 12, repMax: 12, targetRpe: 8, targetRpeMin: 6, prescribedKg: 60, warmups: [],
      cue: '2 second pause in the hole.' },
  ] }] }],
};

async function startNotesSession(page: Page) {
  await page.goto('/');
  await page.getByLabel('I agree').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(notesProgramme)) });
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(doneButton(page)).toBeVisible();
}

test('13. session notes: target RPE, programme notes, AMRAP, clear RPE prompt, edit an earlier exercise', async ({ page }, info) => {
  await startNotesSession(page);
  await expect(page.getByText('AMRAP last set')).toBeVisible(); // exercise badge
  await expect(page.locator('.ex-notes summary')).toContainText('Final set is AMRAP');

  await doneButton(page).click(); // squat set 1
  await expect(page.getByText('How hard was that?')).toBeVisible();
  await expect(page.locator('.set-card .chip.set-type')).toHaveText('AMRAP'); // set 2 = the AMRAP set
  await expect(page.getByText('As many reps as you can · log every rep')).toBeVisible();
  await doneButton(page).click(); // squat set 2 → pause squat

  await expect(page.getByRole('heading', { name: 'Pause Squat' })).toBeVisible();
  await expect(page.locator('.target-line')).toContainText('Target 12 reps · RPE 6–8');
  const rpe = page.getByRole('group', { name: /RPE, optional/ });
  await expect(rpe.locator('.rpe-chip.in-target')).toHaveCount(0); // the squat AMRAP set has no RPE target
  await rpe.getByRole('button', { name: '9', exact: true }).click(); // RPE for the squat AMRAP set
  await doneButton(page).click(); // pause squat set 1: its RPE prompt highlights the 6–8 range
  await expect(rpe.locator('.rpe-chip.in-target')).toHaveCount(5); // 6, 6.5, 7, 7.5, 8

  // Moved on to pause squat, but the squat sets are still editable from the whole-workout list.
  await page.getByRole('button', { name: /^All sets for/ }).click();
  const list = page.getByRole('dialog', { name: 'All sets in this workout' });
  await list.getByRole('button', { name: /^Squat \(Barbell\), Set 2 of 2/ }).click();
  const edit = page.getByRole('dialog', { name: 'Edit logged set' });
  await expect(edit).toContainText('Squat (Barbell)');
  await expect(edit).toContainText('RPE 9');
  await edit.getByRole('button', { name: 'Change reps' }).click();
  const reps = page.getByRole('textbox', { name: /Reps · Squat/ });
  await reps.fill('9');
  await reps.press('Enter');
  await page.getByRole('button', { name: /^All sets for/ }).click();
  await expect(list.getByRole('button', { name: /^Squat \(Barbell\), Set 2 of 2: 100 kg for 9 reps/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Keyboard shortcuts: hidden on touch phones, offered with a keyboard.
  await page.getByRole('button', { name: 'Session menu' }).click();
  const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
  if (info.project.name.startsWith('phone')) await expect(shortcuts).toHaveCount(0);
  else await expect(shortcuts).toBeVisible();
});

test('14. plates & bar: no 25s, typed weight, plate picture uses what you have', async ({ page }) => {
  await onboard(page);
  await openMe(page);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const setup = page.getByRole('dialog', { name: 'Plates & bar' });
  await setup.getByRole('button', { name: /^25 kg plates/ }).click();
  await expect(setup.getByRole('button', { name: /^25 kg plates/ })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByText('20 kg bar · 6 plate sizes')).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'Change weight' }).click();
  const weight = page.getByRole('textbox', { name: /^Weight · Squat/ });
  await expect(weight).toBeFocused(); // typing straight away
  await weight.fill('120');
  await weight.press('Enter');
  await expect(page.getByRole('figure', { name: 'Per side: 20, 20, 10 kg' })).toBeVisible();
});

test('15. plate-loaded machine: switch equipment mid-session, plate picture with no bar', async ({ page }) => {
  const prog = {
    name: 'Legs', deloadEvery: 0,
    blocks: [{ name: 'B', weeks: 1, days: [{ name: 'Mon', exercises: [
      { name: 'Leg Press', loadType: 'machine', restSec: 60, sets: 2, repMin: 10, repMax: 10, targetRpe: null, prescribedKg: 100, warmups: [] },
    ] }] }],
  };
  await page.goto('/');
  await page.getByLabel('I agree').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(prog)) });
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('figure')).toHaveCount(0); // a stack machine: no plates

  await page.getByRole('button', { name: 'Session menu' }).click();
  await page.getByRole('button', { name: 'Equipment: Machine (stack)' }).click();
  await page.getByRole('dialog', { name: 'Equipment' }).getByRole('button', { name: /^Plate-loaded/ }).click();
  await expect(page.getByRole('figure', { name: 'Per side: 25, 25 kg' })).toBeVisible(); // 100 kg = all plates, no bar
  await page.getByRole('button', { name: 'Session menu' }).click();
  await expect(page.getByRole('button', { name: 'Equipment: Plate-loaded' })).toBeVisible();
});

test('16. ME never renders blank: if its code fails to load, a recovery message shows', async ({ page }) => {
  // Simulate the screen's code being unavailable from the start (e.g. a deploy replaced it while the
  // page was open). Blocked before load, so the background preload can't fetch it either.
  await page.route(/features\/me\/MeScreen|assets\/MeScreen-/, (route) => route.abort());
  await onboard(page);
  await openMe(page);
  await expect(page.getByRole('heading', { name: "This screen didn't load" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByText('Your workouts and settings are safe on this phone.')).toBeVisible();

  // Once the code is reachable again, Reload brings ME back.
  await page.unroute(/features\/me\/MeScreen|assets\/MeScreen-/);
  await page.getByRole('button', { name: 'Reload' }).click();
  await openMe(page);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});
