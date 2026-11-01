import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { DEFAULT_MODEL_SETTINGS } from '../fixtures/test-data/model-settings';
import { createMockScene } from '../fixtures/test-data/generated-scene';

test('course issue markers appear only in edit mode and clear after narration is fixed', async ({
  page,
  mockApi,
}, testInfo) => {
  test.setTimeout(120_000);
  await mockApi.mockModelSettings({ ...DEFAULT_MODEL_SETTINGS, media: { tts: 'openai-tts' } });
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  const stageId = uniqueStageId('course-issues');
  const now = Date.now();
  const doc = {
    stage: { id: stageId, name: 'Course issue markers', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 's',
        stageId,
        type: 'slide',
        title: 'Narration',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            elements: [],
          },
        },
        actions: [
          { id: 'a', type: 'speech', text: 'Hello', audioId: undefined as string | undefined },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  };
  await seedServerDocument(page, doc);
  await page.goto(`/classroom/${stageId}`);
  const edit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit).toBeVisible();
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  await edit.click();
  await expect(page.getByTestId('scene-issue-marker')).toHaveAttribute('data-severity', 'warning');
  await expect
    .poll(() =>
      page
        .getByTestId('slide-nav-rail')
        .getByTestId('scene-item')
        .evaluate((element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            if (Number(getComputedStyle(node).opacity) < 1) return false;
          }
          return true;
        }),
    )
    .toBe(true);
  await testInfo.attach('missing-narration', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.goto('about:blank');
  doc.scenes[0].actions[0].audioId = 'allocated-narration';
  await seedServerDocument(page, doc);
  await page.goto(`/classroom/${stageId}`);
  await expect(edit).toBeVisible();
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click();
  await expect(page.getByTestId('slide-nav-rail').getByTestId('scene-item')).toBeVisible();
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .getByTestId('slide-nav-rail')
        .getByTestId('scene-item')
        .evaluate((element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            if (Number(getComputedStyle(node).opacity) < 1) return false;
          }
          return true;
        }),
    )
    .toBe(true);
  await testInfo.attach('narration-fixed', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('a course without server narration only marks content problems and pending media as warnings', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  const stageId = uniqueStageId('no-tts-course-issues');
  const now = Date.now();
  const scenes = Array.from({ length: 8 }, (_, order) => {
    const s = createMockScene(stageId);
    return {
      ...s,
      id: `scene-${order}`,
      order,
      content: { type: 'slide', canvas: { ...s.content.canvas, id: `canvas-${order}` } },
      actions: [{ ...s.actions[0], id: `speech-${order}` }],
      createdAt: now,
      updatedAt: now,
    };
  });
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'No server narration', createdAt: now, updatedAt: now },
    scenes,
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  });
  await page.goto(`/classroom/${stageId}`);
  const edit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit).toBeVisible();
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  await edit.click();
  await expect(page.getByTestId('slide-nav-rail').getByTestId('scene-item')).toHaveCount(8);
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);

  await page.goto('about:blank');
  scenes[0].actions[0].text = '';
  const pending = {
    ...scenes[1],
    content: {
      type: 'slide',
      canvas: {
        ...scenes[1].content.canvas,
        elements: [
          {
            id: 'pending-video',
            type: 'video',
            src: 'gen_vid_pending',
            left: 50,
            top: 160,
            width: 400,
            height: 225,
            autoplay: false,
          },
        ],
      },
    },
  };
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'No server narration', createdAt: now, updatedAt: now },
    scenes: [scenes[0], pending, ...scenes.slice(2)],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  });
  await page.goto(`/classroom/${stageId}`);
  await expect(edit).toBeVisible();
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click();
  const markers = page.getByTestId('scene-issue-marker');
  await expect(markers).toHaveCount(2);
  await expect(markers.nth(0)).toHaveAttribute('data-severity', 'warning');
  await expect(markers.nth(1)).toHaveAttribute('data-severity', 'warning');
});

test('legacy narration does not flash a warning when the scene is renamed', async ({
  page,
  mockApi,
}, testInfo) => {
  test.setTimeout(120_000);
  await mockApi.mockModelSettings({ ...DEFAULT_MODEL_SETTINGS, media: { tts: 'openai-tts' } });
  await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
  const stageId = uniqueStageId('legacy-narration-marker');
  const now = Date.now();
  const scene = {
    ...createMockScene(stageId),
    title: 'Cached narration',
    createdAt: now,
    updatedAt: now,
  };
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Legacy narration marker', createdAt: now, updatedAt: now },
    scenes: [scene],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  });
  await page.goto(`/classroom/${stageId}`);
  const edit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit).toBeVisible();
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  await edit.click();
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(1);
  await page.evaluate(
    async ({ stageId, text }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('maic-device-cache');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = database.transaction('audioFiles', 'readwrite');
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        tx.objectStore('audioFiles').put({
          id: 'tts_s0_action-0',
          stageId,
          text,
          blob: new Blob(['cached narration']),
          format: 'mp3',
          createdAt: Date.now(),
        });
        await done;
      } finally {
        database.close();
      }
    },
    { stageId, text: scene.actions[0].text },
  );
  await page.reload();
  await expect(edit).toBeVisible();
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click();
  const rail = page.getByTestId('slide-nav-rail');
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);
  await rail.evaluate((element) => {
    element.setAttribute('data-observed-markers', '0');
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('[data-testid="scene-issue-marker"]') ||
              node.querySelector('[data-testid="scene-issue-marker"]'))
          ) {
            element.setAttribute(
              'data-observed-markers',
              String(Number(element.getAttribute('data-observed-markers')) + 1),
            );
          }
        }
      }
    }).observe(element, { childList: true, subtree: true });
  });
  await rail.getByTestId('scene-title').dblclick();
  await rail.getByRole('textbox', { name: /rename/i }).fill('Renamed scene');
  await rail.getByRole('textbox', { name: /rename/i }).press('Enter');
  await expect(rail.getByTestId('scene-title')).toHaveText('Renamed scene');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(rail).toHaveAttribute('data-observed-markers', '0');
  await expect(page.getByTestId('scene-issue-marker')).toHaveCount(0);
  await testInfo.attach('renamed-with-legacy-audio', {
    body: await rail.screenshot(),
    contentType: 'image/png',
  });
});

test('cached narration does not flash a marker on mount or when a page is inserted above it', async ({
  page,
  mockApi,
}, testInfo) => {
  test.setTimeout(120_000);
  await mockApi.mockModelSettings({ ...DEFAULT_MODEL_SETTINGS, media: { tts: 'openai-tts' } });
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en-US');
    const observed = { markers: 0 };
    Object.assign(window, { pendingNarrationMarkers: observed });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const markers = node.matches('[data-testid="scene-issue-marker"]')
            ? [node]
            : node.querySelectorAll('[data-testid="scene-issue-marker"]');
          for (const marker of markers) {
            const title = marker
              .closest('[data-testid="scene-item"]')
              ?.querySelector('[data-testid="scene-title"]')?.textContent;
            if (title === 'Cached narration') observed.markers++;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const stageId = uniqueStageId('pending-narration-marker');
  const now = Date.now();
  const scene = {
    ...createMockScene(stageId),
    title: 'Cached narration',
    createdAt: now,
    updatedAt: now,
  };
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Pending narration marker', createdAt: now, updatedAt: now },
    scenes: [scene],
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  });
  await page.goto(`/classroom/${stageId}`);
  const edit = page.getByRole('switch', { name: /edit course/i }).first();
  await expect(edit).toBeVisible();
  await page.evaluate(
    async ({ stageId, text }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('maic-device-cache');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = database.transaction('audioFiles', 'readwrite');
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        for (const order of [0, 2])
          tx.objectStore('audioFiles').put({
            id: `tts_s${order}_action-0`,
            stageId,
            text,
            blob: new Blob(['cached narration']),
            format: 'mp3',
            createdAt: Date.now(),
          });
        await done;
      } finally {
        database.close();
      }
    },
    { stageId, text: scene.actions[0].text },
  );
  await page.reload();
  await expect(edit).toBeVisible();
  await page
    .getByRole('button', { name: /got it/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  if ((await edit.getAttribute('aria-checked')) !== 'true') await edit.click();
  const rail = page.getByTestId('slide-nav-rail');
  const cachedScene = rail.getByTestId('scene-item').filter({ hasText: 'Cached narration' });
  await expect(cachedScene).toBeVisible();
  await expect(cachedScene.getByTestId('scene-issue-marker')).toHaveCount(0);
  const observed = () =>
    page.evaluate(
      () =>
        (window as unknown as { pendingNarrationMarkers: { markers: number } })
          .pendingNarrationMarkers.markers,
    );
  expect(await observed()).toBe(0);
  await rail.getByTestId('slide-nav-insert').first().click();
  await page.getByTestId('scene-type-slide').click();
  await expect(rail.getByTestId('scene-item')).toHaveCount(2);
  await expect(cachedScene.getByTestId('scene-issue-marker')).toHaveCount(0);
  await expect(
    rail.getByTestId('scene-item').first().getByTestId('scene-issue-marker'),
  ).toHaveCount(1);
  expect(await observed()).toBe(0);
  await testInfo.attach('inserted-above-cached-narration', {
    body: await rail.screenshot(),
    contentType: 'image/png',
  });
});
