import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';

test.setTimeout(120_000);

const SCENE_ID = 'scene-pick-transition';

async function seedSlideWithBoard(page: Page, actions: unknown[]): Promise<string> {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/chat') || path.includes('/generate') || path.includes('/tts'))
      return route.abort();
    if (path === '/api/server-providers')
      return route.fulfill({ json: { providers: {}, mediaProviders: {}, defaultModel: null } });
    if (path === '/api/comfyui-workflows') return route.fulfill({ json: { workflows: [] } });
    await route.continue();
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem(
      'maic:account:settings-storage',
      JSON.stringify({
        state: {
          modelId: 'gpt-4o',
          providerId: 'openai',
          providersConfig: { openai: { apiKey: 'mock-only' } },
          agentMode: 'preset',
          selectedAgentIds: [],
          ttsEnabled: false,
          reviewOutlineEnabled: false,
          autoConfigApplied: true,
          sidebarCollapsed: false,
        },
        version: 2,
      }),
    );
  });
  await page.goto('/', { waitUntil: 'networkidle' });

  const stageId = uniqueStageId('e2e-whiteboard-pick-transition');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Whiteboard pick transition',
      whiteboard: [
        {
          id: 'board',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [
            {
              id: 'board-fact',
              type: 'text',
              left: 200,
              top: 180,
              width: 400,
              height: 70,
              rotate: 0,
              content: '<p>Buoyancy equals displaced liquid weight.</p>',
              defaultFontName: 'Arial',
              defaultColor: '#111111',
            },
          ],
        },
      ],
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: SCENE_ID,
        stageId,
        type: 'slide',
        title: 'Slide',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-0',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#5b9bd5'],
              fontColor: '#333333',
              fontName: 'Arial',
            },
            elements: [
              {
                id: 'slide-fact',
                type: 'text',
                left: 100,
                top: 100,
                width: 600,
                height: 80,
                rotate: 0,
                content: '<p>Slide fact</p>',
                defaultFontName: 'Arial',
                defaultColor: '#111111',
              },
            ],
          },
        },
        actions,
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  await setCurrentScene(page, stageId, SCENE_ID);

  const classroom = new ClassroomPage(page);
  await classroom.goto(stageId);
  await classroom.waitForLoaded();
  return stageId;
}

const speech = (id: string) => ({
  id,
  type: 'speech',
  agent: 'teacher',
  text: 'We keep reading this explanation aloud for a while. '.repeat(6),
});

const referenceButton = (page: Page) =>
  page.getByRole('button', { name: 'Reference content', exact: true });
const slidePicker = (page: Page) => page.getByTestId('slide-element-pick-overlay');
const boardPicker = (page: Page) => page.getByTestId('whiteboard-element-pick-overlay');
const boardFact = (page: Page) => page.locator('[id="screen-element-board-fact"] > div').first();

test('closing the whiteboard manually ends an armed whiteboard picker', async ({ page }) => {
  await seedSlideWithBoard(page, []);
  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  await expect(boardFact(page)).toBeVisible();
  await referenceButton(page).click();
  await expect(boardPicker(page)).toBeVisible();

  await page.getByTitle('Minimize Whiteboard', { exact: true }).last().click();
  await expect(boardFact(page)).toBeHidden();
  await expect(boardPicker(page)).toHaveCount(0);
  await expect(slidePicker(page)).toHaveCount(0);

  // The slide picker is still available as a fresh arm.
  await referenceButton(page).click();
  await expect(slidePicker(page)).toBeVisible();
});

test('a Teacher wb_open during playback ends an armed slide picker', async ({ page }) => {
  await seedSlideWithBoard(page, [
    speech('a-speech'),
    { id: 'a-open', type: 'wb_open' },
    speech('a-after'),
  ]);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await referenceButton(page).click();
  await expect(slidePicker(page)).toBeVisible();

  await expect(boardFact(page)).toBeVisible({ timeout: 60_000 });
  await expect(slidePicker(page)).toHaveCount(0);
  await expect(boardPicker(page)).toHaveCount(0);
});

test('a Teacher wb_close during playback ends an armed whiteboard picker', async ({ page }) => {
  await seedSlideWithBoard(page, [
    { id: 'a-open', type: 'wb_open' },
    speech('a-speech'),
    { id: 'a-close', type: 'wb_close' },
    speech('a-after'),
  ]);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect(boardFact(page)).toBeVisible({ timeout: 30_000 });
  await referenceButton(page).click();
  await expect(boardPicker(page)).toBeVisible();

  await expect(boardFact(page)).toBeHidden({ timeout: 60_000 });
  await expect(boardPicker(page)).toHaveCount(0);
  await expect(slidePicker(page)).toHaveCount(0);
});
