import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * The export menu's "Include placeholder slides" setting: on by default,
 * remembered by the browser, and toggling it neither closes the menu nor
 * starts an export.
 */
async function seedCourse(page: Page): Promise<string> {
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  await page.goto('/');
  const stageId = uniqueStageId('e2e-export-placeholders');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Export deck',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: 'scene-slide',
        stageId,
        type: 'slide',
        title: 'Intro',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              fontName: 'Arial',
              fontColor: '#111111',
              backgroundColor: '#ffffff',
              themeColors: ['#4f46e5'],
            },
            background: { type: 'solid', color: '#ffffff' },
            elements: [],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  return stageId;
}

/** Count every download the page starts, from now until the test ends. */
function countDownloads(page: Page): () => number {
  let downloads = 0;
  page.on('download', () => downloads++);
  return () => downloads;
}

async function openExportMenu(page: Page) {
  const exportButton = page.getByRole('button', { name: 'Export PPTX' });
  await expect(exportButton).toBeEnabled({ timeout: 15_000 });
  await exportButton.click();
  await expect(page.getByRole('menu')).toBeVisible();
  return page.getByTestId('export-include-placeholders');
}

test.describe('Export menu: include placeholder slides', () => {
  test('defaults to on, persists, and does not export when clicked', async ({ page }) => {
    const stageId = await seedCourse(page);
    const downloads = countDownloads(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    const toggle = await openExportMenu(page);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.hover();
    await expect(page.getByRole('tooltip')).toContainText('QR code');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('menu')).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem('openmaic:export:pptx-placeholders')),
    ).toBe('false');

    await page.reload();
    await classroom.waitForLoaded();
    await expect(await openExportMenu(page)).toHaveAttribute('aria-checked', 'false');

    // The listener has been attached since before the first click: give a
    // delayed, accidental export time to show up before asserting none did.
    await page.waitForTimeout(1_000);
    expect(downloads()).toBe(0);
  });

  test('works from the keyboard', async ({ page }) => {
    const stageId = await seedCourse(page);
    const downloads = countDownloads(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    const exportButton = page.getByRole('button', { name: 'Export PPTX' });
    await expect(exportButton).toBeEnabled({ timeout: 15_000 });
    await exportButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();

    const toggle = page.getByTestId('export-include-placeholders');
    // Wait for the menu to focus its first item, then step down one item at a
    // time, waiting for focus to move before pressing again.
    const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? '');
    await expect.poll(focusedText).toContain('Export PPTX');
    for (let i = 0; i < 8 && !(await toggle.evaluate((el) => el === document.activeElement)); i++) {
      const before = await focusedText();
      await page.keyboard.press('ArrowDown');
      await expect.poll(focusedText).not.toBe(before);
    }
    await expect(toggle).toBeFocused();
    await expect(page.getByRole('tooltip')).toContainText('QR code');

    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menu')).toBeVisible();

    await page.waitForTimeout(1_000);
    expect(downloads()).toBe(0);
  });
});
