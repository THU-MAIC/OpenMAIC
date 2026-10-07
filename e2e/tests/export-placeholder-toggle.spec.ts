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
  await page.goto('/', { waitUntil: 'networkidle' });
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

test.describe('Export menu: include placeholder slides', () => {
  test('defaults to on, persists, and does not export when toggled', async ({ page }) => {
    const stageId = await seedCourse(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    const exportButton = page.getByRole('button', { name: 'Export PPTX' });
    await exportButton.click();
    const toggle = page.getByTestId('export-include-placeholders');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.hover();
    await expect(page.getByRole('tooltip')).toContainText('QR code');

    let downloads = 0;
    page.on('download', () => downloads++);
    await toggle.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(
      await page.evaluate(() => localStorage.getItem('openmaic:export:pptx-placeholders')),
    ).toBe('false');

    await page.reload();
    await classroom.waitForLoaded();
    await exportButton.click();
    await expect(page.getByTestId('export-include-placeholders')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(downloads).toBe(0);
  });
});
