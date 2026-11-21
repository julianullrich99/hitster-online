/**
 * Language switcher: German by default, English on request, remembered per device.
 */

import { test, expect } from '@playwright/test';

test('German is the default and the switcher changes to English', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('button.btn-create')).toHaveText('⊕ Raum erstellen');
  await expect(page.locator('[data-testid="lang-de"]')).toHaveAttribute('aria-pressed', 'true');

  await page.click('[data-testid="lang-en"]');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('button.btn-create')).toHaveText('⊕ Create a room');

  // Remembered on this device
  await page.reload();
  await expect(page.locator('button.btn-create')).toHaveText('⊕ Create a room');
  expect(await page.evaluate(() => localStorage.getItem('hitster_lang'))).toBe('en');

  // And back
  await page.click('[data-testid="lang-de"]');
  await expect(page.locator('button.btn-create')).toHaveText('⊕ Raum erstellen');
});

test('the switcher is in the room header and translates the lobby', async ({ page }) => {
  await page.goto('/');
  await page.fill('[data-testid="display-name-input"]', 'Sprachtest');
  await page.click('button.btn-create');
  await page.fill('.modal-box input[type="text"]', `Sprache ${Date.now()}`);
  await page.click('.modal-box .btn-create');
  await expect(page.locator('[data-testid="lobby-screen"]')).toBeVisible({ timeout: 8_000 });

  await expect(page.locator('[data-testid="start-round-btn"]')).toHaveText('▶ Runde starten');
  await page.locator('.game-header [data-testid="lang-en"]').click();
  await expect(page.locator('[data-testid="start-round-btn"]')).toHaveText('▶ Start Round');
});
