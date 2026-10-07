import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { test, expect } from '../fixtures/base';
import type { Locator, Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * The export menu's PPTX and Resource Pack submenus: each export is chosen
 * with or without placeholder slides for the lesson's quiz and interactive
 * scenes, and each choice downloads its file.
 */
async function seedCourse(page: Page): Promise<string> {
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  await page.goto('/');
  const stageId = uniqueStageId('e2e-export-pptx-submenus');
  const now = Date.now();
  const scene = (id: string, type: string, order: number, content: Record<string, unknown>) => ({
    id,
    stageId,
    type,
    title: `Scene ${id}`,
    order,
    content,
    createdAt: now,
    updatedAt: now,
  });
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
      scene('slide', 'slide', 0, {
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
      }),
      scene('widget', 'interactive', 1, {
        type: 'interactive',
        url: '',
        html: '<!doctype html><html><body><h1>Widget</h1></body></html>',
      }),
      scene('quiz', 'quiz', 2, {
        type: 'quiz',
        questions: [{ id: 'q1', type: 'single', question: 'Ready?', options: [], answer: [] }],
      }),
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  return stageId;
}

async function openClassroom(page: Page) {
  const stageId = await seedCourse(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(stageId);
  await classroom.waitForLoaded();
  await expect(page.getByRole('button', { name: 'Export PPTX' })).toBeEnabled({
    timeout: 15_000,
  });
}

async function openExportMenu(page: Page) {
  await page.getByRole('button', { name: 'Export PPTX' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

const subTrigger = (page: Page, name: RegExp) => page.getByRole('menuitem', { name });

/** Click `item` and return the downloaded file's bytes and name. */
async function download(page: Page, item: Locator) {
  const [file] = await Promise.all([page.waitForEvent('download'), item.click()]);
  return { name: file.suggestedFilename(), bytes: await fs.readFile((await file.path())!) };
}

async function slideCount(pptx: Buffer | Uint8Array): Promise<number> {
  const zip = await JSZip.loadAsync(pptx);
  return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}

test.describe('Export menu: PPTX and Resource Pack submenus', () => {
  test('PPTX: slides only and with placeholder slides each download a deck', async ({ page }) => {
    await openClassroom(page);

    await openExportMenu(page);
    await subTrigger(page, /^Export PPTX/).hover();
    const slidesOnly = page.getByRole('menuitem', { name: /^Slides only/ });
    await expect(slidesOnly).toBeVisible();
    const plain = await download(page, slidesOnly);
    expect(plain.name).toMatch(/\.pptx$/);
    expect(await slideCount(plain.bytes)).toBe(1);

    await openExportMenu(page);
    await subTrigger(page, /^Export PPTX/).hover();
    const withPlaceholders = page.getByRole('menuitem', { name: /^With placeholder slides/ });
    await expect(withPlaceholders).toBeVisible();
    const full = await download(page, withPlaceholders);
    // The interactive and quiz scenes add one placeholder slide each.
    expect(await slideCount(full.bytes)).toBe(3);
  });

  test('PPTX submenu works from the keyboard', async ({ page }) => {
    await openClassroom(page);
    const exportButton = page.getByRole('button', { name: 'Export PPTX' });
    await exportButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();

    const trigger = subTrigger(page, /^Export PPTX/);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const withPlaceholders = page.getByRole('menuitem', { name: /^With placeholder slides/ });
    await expect(withPlaceholders).toBeFocused();

    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(await slideCount(await fs.readFile((await file.path())!))).toBe(3);
  });

  test('Resource Pack: both choices download a ZIP with the interactive page', async ({ page }) => {
    await openClassroom(page);

    for (const [name, slides] of [
      [/^PPTX with placeholders/, 3],
      [/^Slides-only PPTX/, 1],
    ] as const) {
      await openExportMenu(page);
      await subTrigger(page, /^Export Resource Pack/).hover();
      const item = page.getByRole('menuitem', { name });
      await expect(item).toBeVisible();
      const pack = await download(page, item);
      expect(pack.name).toMatch(/\.zip$/);
      const zip = await JSZip.loadAsync(pack.bytes);
      const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      expect(files).toContain('interactive/01_Scene widget.html');
      const deck = files.find((n) => n.endsWith('.pptx'));
      expect(deck).toBeDefined();
      expect(await slideCount(await zip.file(deck!)!.async('uint8array'))).toBe(slides);
    }
  });
});
