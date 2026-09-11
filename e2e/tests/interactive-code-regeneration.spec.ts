import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const STAGE_ID = 'e2e-code-regeneration';
const SCENE_ID = 'scene-code';
const OUTLINE_ID = 'outline-code';
const IFRAME_TITLE = `Interactive Scene ${SCENE_ID}`;
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

const OLD_HTML = `<!doctype html><html><head><style>
  html, body { min-height: 100vh; overflow-y: auto; }
  #oversized-chart { height: 5000px; }
</style></head><body><main id="old-code"><div id="oversized-chart">old Python code</div></main></body></html>`;

const NEW_HTML =
  '<!doctype html><html><head></head><body><main id="new-code">new Python code</main></body></html>';

async function seedCodeClassroom(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page.evaluate(
    ({ stageId, sceneId, outlineId, html }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('maic-documents', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
        };
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
          const now = Date.now();
          const outline = {
            id: outlineId,
            type: 'interactive',
            title: 'Normal MLE coding',
            description: 'Implement the normal-distribution MLE.',
            keyPoints: ['log likelihood', 'mean', 'variance'],
            order: 0,
            widgetType: 'code',
            widgetOutline: { language: 'python' },
          };

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Code regeneration test',
            description: '',
            languageDirective: 'Write learner-facing text in English.',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
            dslVersion: '0.1.0',
          });
          tx.objectStore('scenes').put({
            id: sceneId,
            outlineId,
            stageId,
            type: 'interactive',
            title: outline.title,
            order: 0,
            actions: [{ id: 'speech-1', type: 'speech', text: 'Keep this narration.' }],
            content: { type: 'interactive', url: '', html, widgetType: 'code' },
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('outlines').put({
            stageId,
            outline: {
              outlines: [outline],
              generationComplete: true,
              createdAt: now,
              updatedAt: now,
            },
          });

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { stageId: STAGE_ID, sceneId: SCENE_ID, outlineId: OUTLINE_ID, html: OLD_HTML },
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test(`bounds generated root scrolling and regenerates the code widget on ${viewport.name}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedCodeClassroom(page);
    // This fixture is deliberately local-only, so provide the viewer metadata
    // that a persisted server-backed classroom would return for its owner.
    await page.route(`**/api/stage-meta/${STAGE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          isOwner: true,
          isPublic: false,
          publishedAt: null,
          generationComplete: true,
          source: 'e2e-fixture',
        }),
      });
    });
    await page.route('**/api/generate/scene-content', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.outline.id).toBe(OUTLINE_ID);
      expect(body.stageId).toBe(STAGE_ID);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          content: { html: NEW_HTML, widgetType: 'code' },
        }),
      });
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE_ID);
    await classroom.waitForLoaded();

    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const badResponses: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });

    const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
    await expect(frame.locator('#old-code')).toBeVisible();
    const rootMetrics = await frame.locator('html').evaluate(() => ({
      viewportHeight: window.innerHeight,
      htmlClientHeight: document.documentElement.clientHeight,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
    }));
    expect(rootMetrics).toMatchObject({
      viewportHeight: 720,
      htmlClientHeight: 720,
      bodyClientHeight: 720,
      htmlOverflowY: 'hidden',
      bodyOverflowY: 'auto',
    });
    expect(rootMetrics.bodyScrollHeight).toBeGreaterThan(720);

    const regenerate = page.getByRole('button', { name: 'Regenerate code' });
    await expect(regenerate).toBeVisible();
    const buttonBox = await regenerate.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.x).toBeGreaterThanOrEqual(0);
    expect(buttonBox!.y).toBeGreaterThanOrEqual(0);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/openmaic-code-regeneration-${viewport.name}-before.png`,
      fullPage: true,
    });

    await frame.locator('body').evaluate((body) => {
      body.scrollTop = 900;
    });
    expect(await frame.locator('body').evaluate((body) => body.scrollTop)).toBe(900);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await frame.locator('body').evaluate((body) => {
      body.scrollTop = 0;
    });

    await regenerate.click();
    await expect(page.getByText('Code regenerated')).toBeVisible();
    await expect(frame.locator('#new-code')).toBeVisible();
    await expect(frame.locator('#old-code')).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/openmaic-code-regeneration-${viewport.name}-after.png`,
      fullPage: true,
    });

    expect(badResponses).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
