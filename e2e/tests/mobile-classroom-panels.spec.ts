import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId, setCurrentScene } from '../fixtures/server-seed';
import { DEFAULT_MODEL_SETTINGS } from '../fixtures/test-data/model-settings';
import guide from '../../public/guide-course/zh.json';
import { TINY_MP4_BASE64 } from '../fixtures/test-data/tiny-video';

test.describe('Phone classroom materials panels', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('keeps materials closed until requested and preserves one bottom composer', async ({
    page,
  }, testInfo) => {
    const id = uniqueStageId('mobile-panels');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[0].id);
    await page.goto(`/classroom/${id}`);
    await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
    const panel = page.getByTestId('mobile-classroom-lecture');
    const input = page.locator('.mobile-roundtable-input textarea');
    await expect(panel).not.toBeVisible();
    await expect(input).toBeInViewport();
    await expect(page.locator('.mobile-roundtable-input')).toHaveCount(1);
    const composer = await input.boundingBox();
    const nav = await page.getByTestId('mobile-classroom-nav').boundingBox();
    expect(composer!.y).toBeGreaterThan(700);
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(nav!.y);
    const prev = await page
      .getByRole('button', { name: 'Previous scene', exact: true })
      .boundingBox();
    const play = await page
      .getByTestId('mobile-roundtable')
      .getByRole('button', { name: 'Play', exact: true })
      .boundingBox();
    const next = await page.getByRole('button', { name: 'Next scene', exact: true }).boundingBox();
    const speed = await page
      .getByRole('button', { name: 'Playback speed', exact: true })
      .boundingBox();
    expect(prev!.x).toBeLessThan(play!.x);
    expect(play!.x).toBeLessThan(next!.x);
    expect(next!.x).toBeLessThan(speed!.x);
    await expect(page.locator('.mobile-roundtable-role-label')).toHaveCount(3);
    await input.fill('Keep this question while reading materials');
    for (const target of ['lecture', 'chat', 'directory']) {
      await page.getByTestId(`mobile-nav-${target}`).click();
      if (target === 'directory') await expect(page.getByTestId('scene-list')).toBeVisible();
      else await expect(panel).toBeVisible();
      await page.getByTestId('mobile-panel-close').click();
      await expect(panel).not.toBeVisible();
      await expect(input).toBeInViewport();
      await expect(input).toHaveValue('Keep this question while reading materials');
    }
    await page.getByTestId('mobile-nav-lecture').click();
    await page.locator('.mobile-panel-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(panel).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('portrait-panels-closed.png') });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(panel).not.toBeVisible();
    await expect(page.getByTestId('classroom-canvas-region')).toBeVisible();
    await page.getByTestId('mobile-nav-chat').click();
    await expect(input).toBeInViewport();
    await expect(input).toHaveValue('Keep this question while reading materials');
    await page.getByTestId('mobile-panel-close').click();
    await page.screenshot({ path: testInfo.outputPath('landscape-panels-closed.png') });
    await page.setViewportSize({ width: 360, height: 640 });
    await expect(input).toBeInViewport();
    await expect(page.getByTestId('mobile-classroom-nav')).toBeInViewport();
  });
});

test.describe('Phone canvas chrome inside the workspace', () => {
  test.skip(process.env.MOBILE_WORKSPACE_E2E !== 'true', 'Requires workspace server');
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('anchors the mask to the canvas and fills the same region when the whiteboard opens', async ({
    page,
  }, testInfo) => {
    const id = uniqueStageId('mobile-canvas-chrome');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[0].id);
    await page.goto(`/workspace?course=${id}`);
    const canvas = page.getByTestId('classroom-canvas-region');
    await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
    const chrome = page.locator('.mobile-canvas-chrome');
    if ((await chrome.getAttribute('data-visible')) !== 'true')
      await canvas.click({ position: { x: 10, y: 100 } });
    await expect(chrome).toHaveAttribute('data-visible', 'true');
    const region = (await canvas.boundingBox())!;
    const mask = (await chrome.boundingBox())!;
    expect(Math.abs(mask.y - region.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(mask.height - region.height)).toBeLessThanOrEqual(1);
    const centerPlay = (await page.locator('.mobile-canvas-play').boundingBox())!;
    expect(
      Math.abs(centerPlay.x + centerPlay.width / 2 - (region.x + region.width / 2)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(centerPlay.y + centerPlay.height / 2 - (region.y + region.height / 2)),
    ).toBeLessThanOrEqual(1);
    await expect(page.locator('.mobile-canvas-header').getByRole('button')).toHaveCount(1);
    const footer = page.locator('.mobile-canvas-footer');
    await expect(footer.getByRole('button')).toHaveCount(2);
    const cc = (await footer.getByRole('button', { name: 'Captions', exact: true }).boundingBox())!;
    const fullscreen = (await footer
      .getByRole('button', { name: 'Fullscreen', exact: true })
      .boundingBox())!;
    expect(cc.x).toBeGreaterThan(region.width / 2);
    expect(cc.x).toBeLessThan(fullscreen.x);
    expect(cc.y + cc.height).toBeGreaterThan(region.y + region.height - 12);
    await page.screenshot({ path: testInfo.outputPath('canvas-mask-390.png') });
    await canvas.click({ position: { x: 10, y: 100 } });
    await expect(chrome).toHaveAttribute('data-visible', 'false');
    await canvas.click({ position: { x: 10, y: 100 } });
    await page.locator('.mobile-canvas-play').click();
    await expect(page.locator('.mobile-canvas-play')).toHaveAttribute('aria-label', 'Pause');
    await page.locator('.mobile-canvas-play').click();
    await expect(chrome).toHaveAttribute('data-visible', 'true');
    await expect(chrome).toHaveAttribute('data-visible', 'false', { timeout: 3500 });
    await page.getByRole('button', { name: 'Open Whiteboard', exact: true }).click();
    const board = page.getByTestId('mobile-whiteboard');
    await expect(board).toBeVisible();
    const boardRegion = (await canvas.boundingBox())!;
    const boardBox = (await board.boundingBox())!;
    expect(Math.abs(boardBox.y - boardRegion.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(boardBox.height - boardRegion.height)).toBeLessThanOrEqual(1);
    await expect(page.locator('.mobile-roundtable-full-speech')).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('whiteboard-workspace-390.png') });
    await page.setViewportSize({ width: 844, height: 390 });
    const landscapeRegion = (await canvas.boundingBox())!;
    const landscapeBoard = (await board.boundingBox())!;
    expect(Math.abs(landscapeBoard.y - landscapeRegion.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(landscapeBoard.height - landscapeRegion.height)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('whiteboard-workspace-844.png') });
  });
  test('keeps the workspace whiteboard header at the top of the expanded canvas', async ({
    page,
  }) => {
    const id = uniqueStageId('mobile-board-workspace');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[0].id);
    await page.goto(`/workspace?course=${id}`);
    await page.getByRole('button', { name: 'Open Whiteboard', exact: true }).click();
    const board = page.getByTestId('mobile-whiteboard');
    await expect(board).toBeVisible();
    const canvasBox = (await page.getByTestId('classroom-canvas-region').boundingBox())!;
    const boardBox = (await board.boundingBox())!;
    expect(Math.abs(boardBox.y - canvasBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(boardBox.height - canvasBox.height)).toBeLessThanOrEqual(1);
    await expect(page.locator('.mobile-roundtable-full-speech')).not.toBeVisible();
  });
});

test.describe('Phone sound settings and quiz report', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('centers sound settings and preserves volume, sound and auto-play choices', async ({
    page,
    mockApi,
  }, testInfo) => {
    await mockApi.mockModelSettings({ ...DEFAULT_MODEL_SETTINGS, media: { tts: 'openai-tts' } });
    const id = uniqueStageId('mobile-sound-settings');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[0].id);
    await page.goto(`/classroom/${id}`);
    const volume = page.getByRole('button', { name: 'Volume', exact: true });
    await volume.click();
    const dialog = page.getByRole('dialog', { name: 'Sound settings', exact: true });
    await expect(dialog).toBeVisible();
    const slider = dialog.getByRole('slider', { name: 'Volume', exact: true });
    await expect(slider).toBeEnabled();
    await slider.fill('0.7');
    await expect(dialog.getByText('70%', { exact: true })).toBeVisible();
    const sound = dialog.getByRole('checkbox', { name: 'Play sound', exact: true });
    await expect(sound).toBeChecked();
    await sound.uncheck();
    const autoPlay = dialog.getByRole('checkbox', { name: 'Auto-play', exact: true });
    await autoPlay.check();
    await page.screenshot({ path: testInfo.outputPath('sound-settings-390.png') });
    for (const size of [
      { width: 360, height: 640 },
      { width: 844, height: 390 },
      { width: 390, height: 400 },
    ]) {
      await page.setViewportSize(size);
      await expect
        .poll(async () => {
          const r = await dialog.boundingBox();
          return (
            !!r &&
            r.x >= 12 &&
            r.y >= 12 &&
            r.x + r.width <= size.width - 12 &&
            r.y + r.height <= size.height - 12 &&
            Math.abs(r.x + r.width / 2 - size.width / 2) <= 2 &&
            Math.abs(r.y + r.height / 2 - size.height / 2) <= 2
          );
        })
        .toBe(true);
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await volume.click();
    await expect(slider).toHaveValue('0.7');
    await expect(sound).not.toBeChecked();
    await expect(autoPlay).toBeChecked();
    await autoPlay.uncheck();
    await sound.check();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 844, height: 390 });
    if ((await page.locator('.mobile-canvas-chrome').getAttribute('data-visible')) !== 'true') {
      await page.getByTestId('classroom-canvas-region').click({ position: { x: 10, y: 80 } });
    }
    await page
      .locator('.mobile-canvas-footer')
      .getByRole('button', { name: 'Fullscreen', exact: true })
      .click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await volume.click();
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => dialog.evaluate((node) => document.fullscreenElement?.contains(node)))
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => document.exitFullscreen());
  });

  test('fills the workspace quiz area and opens the report at its start', async ({
    page,
  }, testInfo) => {
    test.skip(process.env.MOBILE_WORKSPACE_E2E !== 'true', 'Requires workspace server');
    const id = uniqueStageId('mobile-quiz-report');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[6].id);
    await page.goto(`/workspace?course=${id}`);
    await page.getByRole('button', { name: 'Start Quiz', exact: true }).click();
    const quiz = guide.scenes[6].content;
    if (quiz.type !== 'quiz' || !('questions' in quiz)) throw new Error('Missing quiz');
    for (const question of quiz.questions) {
      const option = question.options.find((option) => option.value === question.answer[0])!;
      await page.getByText(option.label, { exact: true }).click();
    }
    await page.getByRole('button', { name: 'Submit Answers', exact: true }).click();
    await expect(page.getByTestId('course-end')).toBeVisible();
    await page.getByTestId('course-end-close').click();
    await expect(page.getByTestId('course-end')).not.toBeVisible();
    const header = page.getByText('Quiz Report', { exact: true });
    await expect(header).toBeVisible();
    const canvas = page.getByTestId('classroom-canvas-region');
    await expect
      .poll(async () => {
        const c = (await canvas.boundingBox())!;
        const h = (await header.boundingBox())!;
        const navigation = (await page.getByTestId('mobile-quiz-navigation').boundingBox())!;
        return (
          Math.abs(navigation.y - c.y) <= 1 &&
          Math.abs(h.y - (navigation.y + navigation.height)) < 30
        );
      })
      .toBe(true);
    await expect(page.getByText(quiz.questions[0].question, { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('quiz-report-390.png') });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(header).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('quiz-report-844.png') });
  });
});

test.describe('Phone classroom first paint and role strip', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('uses the phone loading frame before the course arrives and before hydration', async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(process.env.MOBILE_WORKSPACE_E2E !== 'true', 'Requires workspace server');
    const id = uniqueStageId('mobile-loading-frame');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/persistence/documents/${id}`, async (route) => {
      if (route.request().method() === 'GET') await gate;
      await route.continue();
    });
    try {
      await page.goto(`/workspace?course=${id}`);
      await expect(page.getByTestId('classroom-pane-loading')).toBeVisible();
      await expect(page.getByTestId('workbench-editor-header')).not.toBeVisible();
      const box = (await page.getByTestId('workspace-classroom-pane').boundingBox())!;
      expect(box.y).toBe(0);
      expect(box.width).toBe(390);
      expect(box.height).toBe(844);
      await page.screenshot({ path: testInfo.outputPath('phone-loading-390.png') });
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(page.getByTestId('workbench-editor-header')).not.toBeVisible();
      const landscape = (await page.getByTestId('workspace-classroom-pane').boundingBox())!;
      expect(landscape.y).toBe(0);
      expect(landscape.width).toBe(844);
      expect(landscape.height).toBe(390);
      await page.setViewportSize({ width: 390, height: 844 });
    } finally {
      release();
    }
    await expect(page.getByTestId('mobile-roundtable')).toBeVisible();
    const noScript = await browser.newContext({
      viewport: { width: 390, height: 844 },
      javaScriptEnabled: false,
    });
    try {
      const cold = await noScript.newPage();
      await cold.goto(new URL(`/workspace?course=${id}`, page.url()).href);
      await expect(cold.getByTestId('workspace-classroom-pane')).toBeVisible();
      await expect(cold.getByTestId('workbench-editor-header')).toHaveCount(1);
      await expect(cold.getByTestId('workbench-editor-header')).not.toBeVisible();
    } finally {
      await noScript.close();
    }
  });

  test('keeps the first teacher avatar and its highlight inside the scroll strip', async ({
    page,
  }, testInfo) => {
    const id = uniqueStageId('mobile-avatar-padding');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[0].id);
    await page.goto(`/classroom/${id}`);
    await expect(page.getByTestId('mobile-roundtable')).toBeVisible();
    const row = page.locator('.mobile-roundtable-roles');
    const avatar = page.locator(
      '.mobile-roundtable-role[data-role="teacher"] .mobile-roundtable-avatar',
    );
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const strip = (await row.boundingBox())!;
      const image = (await avatar.boundingBox())!;
      const ring = await avatar.evaluate((el) => {
        const css = getComputedStyle(el);
        return parseFloat(css.outlineWidth) + Math.max(0, parseFloat(css.outlineOffset));
      });
      expect(image.x - ring).toBeGreaterThanOrEqual(strip.x);
      expect(image.y - ring).toBeGreaterThanOrEqual(strip.y);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('complete-teacher-avatar-390.png') });
  });
});

test.describe('Phone quiz exit navigation', () => {
  test.use({ isMobile: true, hasTouch: true });
  for (const hosted of [false, true]) {
    for (const size of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      test(`keeps Back reachable on the quiz cover, answers and report (${hosted ? 'workspace' : 'standalone'}, ${size.width})`, async ({
        page,
      }, testInfo) => {
        test.skip(
          hosted && process.env.MOBILE_WORKSPACE_E2E !== 'true',
          'Requires workspace server',
        );
        test.setTimeout(60_000);
        await page.setViewportSize(size);
        const id = uniqueStageId('mobile-quiz-back');
        await page.goto('/');
        await seedServerDocument(page, {
          ...guide,
          stage: { ...guide.stage, id },
          scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
        });
        await setCurrentScene(page, id, guide.scenes[6].id);
        const url = hosted ? `/workspace?course=${id}` : `/classroom/${id}`;
        await page.goto(url);
        const navigation = page.getByTestId('mobile-quiz-navigation');
        const back = navigation.getByRole('button', { name: 'Back', exact: true });
        await expect(back).toBeInViewport();
        await expect(navigation).toContainText(guide.stage.name);
        await back.click();
        await expect(page).toHaveURL(hosted ? /\/workspace\/?$/ : /\/$/);
        await expect(page.getByTestId('mobile-classroom-nav')).not.toBeVisible();
        await page.goto(url);
        await page.getByRole('button', { name: 'Start Quiz', exact: true }).click();
        await expect(back).toBeInViewport();
        await expect(page.locator('.mobile-canvas-chrome')).toHaveAttribute(
          'data-visible',
          'false',
        );
        const quiz = guide.scenes[6].content;
        if (quiz.type !== 'quiz' || !('questions' in quiz)) throw new Error('Missing quiz');
        for (const question of quiz.questions) {
          const option = question.options.find((option) => option.value === question.answer[0])!;
          await page.getByText(option.label, { exact: true }).click();
        }
        await page.getByRole('button', { name: 'Submit Answers', exact: true }).click();
        await expect(page.getByTestId('course-end')).toBeVisible();
        await page.getByTestId('course-end-close').click();
        await expect(page.getByTestId('course-end')).not.toBeVisible();
        await expect(page.getByText('Quiz Report', { exact: true })).toBeVisible();
        await expect(back).toBeInViewport();
        const navBox = (await navigation.boundingBox())!;
        const header = (await page.getByText('Quiz Report', { exact: true }).boundingBox())!;
        expect(header.y).toBeGreaterThanOrEqual(navBox.y + navBox.height);
        await page.screenshot({ path: testInfo.outputPath(`quiz-back-${size.width}.png`) });
        await back.click();
        await expect(page).toHaveURL(hosted ? /\/workspace\/?$/ : /\/$/);
        await expect(page.getByTestId('mobile-classroom-nav')).not.toBeVisible();
      });
    }
  }
});

test.describe('Phone classroom return contracts', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('honors workspace and home return URLs for standalone quizzes', async ({ page }) => {
    test.skip(process.env.MOBILE_WORKSPACE_E2E !== 'true', 'Requires workspace server');
    const id = uniqueStageId('mobile-exit-contract');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[6].id);
    for (const query of ['from=workspace', 'returnTo=home', 'from=workspace&returnTo=home']) {
      await page.goto(`/classroom/${id}?${query}`);
      await page
        .getByTestId('mobile-quiz-navigation')
        .getByRole('button', { name: 'Back', exact: true })
        .click();
      await expect(page).toHaveURL(query.includes('from=workspace') ? /\/workspace\/?$/ : /\/$/);
      await expect(page.getByTestId('mobile-classroom-nav')).not.toBeVisible();
    }
  });

  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`recovers hidden player controls over a full-frame video (${size.width})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const id = uniqueStageId('mobile-video-exit');
      const scene = structuredClone(guide.scenes[0]);
      if (scene.content.type !== 'slide' || !('canvas' in scene.content))
        throw new Error('Missing slide');
      await page.goto('/');
      await seedServerDocument(page, {
        ...guide,
        stage: { ...guide.stage, id },
        scenes: [
          {
            ...scene,
            stageId: id,
            actions: [],
            content: {
              ...scene.content,
              canvas: {
                ...scene.content.canvas,
                elements: [
                  {
                    id: 'full-frame-video',
                    type: 'video',
                    src: `data:video/mp4;base64,${TINY_MP4_BASE64}`,
                    left: 0,
                    top: 0,
                    width: 1000,
                    height: 562.5,
                    rotate: 0,
                    autoplay: false,
                  },
                ],
              },
            },
          },
        ],
      });
      await setCurrentScene(page, id, scene.id);
      await page.goto(`/classroom/${id}`);
      const video = page.locator('[data-video-element] video');
      await expect(video).toBeVisible();
      const chrome = page.locator('.mobile-canvas-chrome');
      await expect(chrome).toHaveAttribute('data-visible', 'false', { timeout: 4000 });
      await page.getByRole('button', { name: 'Playback controls', exact: true }).click();
      await expect(chrome).toHaveAttribute('data-visible', 'true');
      await expect(page.locator('.mobile-canvas-play')).toHaveAttribute('aria-label', 'Play');
      await expect(page.getByRole('button', { name: 'Captions', exact: true })).toBeVisible();
      await page
        .locator('.mobile-canvas-header')
        .getByRole('button', { name: 'Back', exact: true })
        .click();
      await expect(page).toHaveURL(/\/$/);
    });

    test(`recovers hidden player controls on the desktop-only project notice (${size.width})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const id = uniqueStageId('mobile-project-exit');
      await page.goto('/');
      await seedServerDocument(page, {
        ...guide,
        stage: { ...guide.stage, id },
        scenes: [
          {
            ...guide.scenes[0],
            id: 'project',
            stageId: id,
            type: 'pbl',
            title: 'Practice project',
            content: { type: 'pbl', projectV3: { id: 'greeting-python-lab', version: '1.1.0' } },
            actions: [],
          },
        ],
      });
      await setCurrentScene(page, id, 'project');
      await page.goto(`/classroom/${id}`);
      await expect(
        page.getByText(
          'Preview is not available on phones. Open this project on a computer to try it.',
          { exact: false },
        ),
      ).toBeVisible();
      await expect(page.getByTestId('pbl-v3-entry')).toHaveCount(0);
      await expect(page.getByTestId('pbl-workspace-frame')).toHaveCount(0);
      const chrome = page.locator('.mobile-canvas-chrome');
      await expect(chrome).toHaveAttribute('data-visible', 'false', { timeout: 4000 });
      const recovery = page.getByRole('button', { name: 'Playback controls', exact: true });
      await expect(recovery).toBeVisible();
      await recovery.click();
      await expect(chrome).toHaveAttribute('data-visible', 'true');
      await page
        .locator('.mobile-canvas-header')
        .getByRole('button', { name: 'Back', exact: true })
        .click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('mobile-classroom-nav')).not.toBeVisible();
    });
  }
});
