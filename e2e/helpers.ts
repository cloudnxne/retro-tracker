import { expect, type Page } from '@playwright/test';

/** Fresh browser context = empty IndexedDB. Consent, then the starter programme, then the ready screen. */
export async function onboard(page: Page) {
  await page.goto('/');
  await page.getByLabel('I agree').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use a starter programme' }).click();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
}

export async function startSession(page: Page) {
  await onboard(page);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('button', { name: /^Log |All sets logged/ })).toBeVisible();
}

/** The big DONE button (its accessible name describes the set it logs). */
export const doneButton = (page: Page) => page.getByRole('button', { name: /^Log / });

/** First time on an exercise the app asks for a weight; answer with the +/- sheet. */
export async function answerWeightIfAsked(page: Page) {
  if (!(await page.getByText('What will you lift today?').isVisible())) return;
  await expect(doneButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Change weight' }).click();
  const up = page.getByRole('button', { name: /^Increase by/ });
  for (let i = 0; i < 8; i++) await up.click();
  await page.getByRole('button', { name: 'SAVE' }).click();
}
