import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId, setCurrentScene } from '../fixtures/server-seed';
import guide from '../../public/guide-course/zh.json';

test.describe('Mobile classroom with the shared playback surface', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('keeps the classroom anchored when Safari pans the visual viewport during a swipe', async ({
    page,
  }) => {
    const id = uniqueStageId('classroom-pan');
    const interactive = guide.scenes.find((scene) => scene.type === 'interactive')!;
    await page.goto('/');
    await seedServerDocument(page, {
      stage: { ...guide.stage, id },
      scenes: [{ ...interactive, stageId: id }],
    });
    await setCurrentScene(page, id, interactive.id);
    await page.goto(`/classroom/${id}`);
    const root = page.locator('[data-playback-stage]');
    await expect(page.locator('.mobile-roundtable-input textarea')).toBeVisible();
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 110 });
      viewport.dispatchEvent(new Event('scroll'));
    });
    await expect(root).toHaveCSS('--classroom-visible-top', '110px');
    await expect(root).toHaveCSS('top', '0px');
    await page.locator('.mobile-roundtable-input textarea').focus();
    await expect(root).toHaveCSS('top', '110px');
    await page.locator('.mobile-roundtable-input textarea').blur();
    await expect(root).toHaveCSS('top', '0px');
  });

  test('keeps the interactive viewport aligned through in-page rotation', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined });
    });
    const id = uniqueStageId('interactive-rotation');
    const interactive = guide.scenes.find((scene) => scene.type === 'interactive')!;
    await page.goto('/');
    await seedServerDocument(page, {
      stage: { ...guide.stage, id },
      scenes: [{ ...interactive, stageId: id }],
    });
    await setCurrentScene(page, id, interactive.id);
    await page.goto(`/classroom/${id}`);
    const frame = page.locator('iframe[title^="Interactive Scene"]');
    const slot = page.getByTestId('classroom-canvas-region');
    const button = page.locator('.mobile-canvas-footer button').last();
    await expect(frame).toBeVisible();
    await frame.evaluate((el) => el.setAttribute('data-retained', 'true'));
    const menu = page.locator('.mobile-canvas-menu');
    const chrome = page.locator('.mobile-canvas-chrome');
    for (const landscape of [true, false]) {
      await menu.click();
      await expect(chrome).toHaveAttribute('data-visible', 'true');
      await button.click();
      await expect(page.locator('[data-playback-stage]')).toHaveAttribute(
        'data-landscape',
        String(landscape),
      );
      await expect
        .poll(async () => {
          const viewport = await frame.locator('..').boundingBox();
          const canvas = await slot.boundingBox();
          if (!viewport || !canvas) return false;
          return (
            Math.abs(viewport.x - canvas.x) < 2 &&
            Math.abs(viewport.y - canvas.y) < 2 &&
            Math.abs(viewport.width - canvas.width) < 2 &&
            Math.abs(viewport.height - canvas.height) < 2
          );
        })
        .toBe(true);
      await expect(frame).toHaveAttribute('data-retained', 'true');
      await expect(chrome).toHaveAttribute('data-visible', 'false', { timeout: 4000 });
      await expect(menu).toBeVisible();
    }
  });

  test('fills portrait, keeps the interactive frame across panels and rotation, and focuses quizzes', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const id = uniqueStageId('mobile-layout');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await setCurrentScene(page, id, guide.scenes[0].id);
    await page.goto(`/classroom/${id}`);
    const root = page.locator('[data-playback-stage]');
    await expect(root).toHaveAttribute('data-mobile', 'true');
    await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
    await expect(page.getByTestId('mobile-roundtable')).toBeVisible();
    await expect(page.getByTestId('mobile-classroom-lecture')).not.toBeVisible();
    const slide = await page.getByTestId('classroom-canvas-region').boundingBox();
    expect(slide!.width).toBeGreaterThan(350);
    expect(slide!.height).toBeLessThan(250);
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const button of await page.locator('[data-mobile-toolbar]').getByRole('button').all()) {
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .locator('.mobile-roundtable-input textarea')
      .fill('A question to keep across rotation');
    await page.screenshot({ path: testInfo.outputPath('lesson-390.png') });
    // A portrait phone can have a landscape-shaped viewport above its keyboard.
    const composer = page.locator('.mobile-roundtable-input textarea');
    await page.setViewportSize({ width: 390, height: 345 });
    await expect(root).toHaveAttribute('data-landscape', 'false');
    await expect(composer).toBeFocused();
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect(composer).toHaveValue('A question to keep across rotation');
    await expect(page.getByTestId('mobile-classroom-nav')).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByTestId('mobile-nav-directory').click();
    await page.getByTestId('scene-item').nth(3).click();
    // The production keep-alive host is a sibling of PlaybackChromeRoot.
    const frame = page.locator('iframe[title^="Interactive Scene"]').first();
    await expect(frame).toBeVisible();
    await page.frameLocator('iframe[title^="Interactive Scene"]').locator('#btn-speed').click();
    await expect(
      page.frameLocator('iframe[title^="Interactive Scene"]').locator('#btn-speed'),
    ).toHaveClass(/done/);
    await page.screenshot({ path: testInfo.outputPath('interactive-390.png') });
    await frame.evaluate((node) => {
      node.setAttribute('data-continuity-test', 'preserved');
    });
    await page.getByTestId('mobile-nav-chat').click();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(frame).toHaveAttribute('data-continuity-test', 'preserved');
    await expect(page.locator('.mobile-roundtable-input textarea')).toBeVisible();
    await expect(page.locator('.mobile-roundtable-input textarea')).toHaveValue(
      'A question to keep across rotation',
    );
    await page.getByTestId('mobile-nav-classroom').click();
    await expect(frame).toBeVisible();
    await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(
      page.frameLocator('iframe[title^="Interactive Scene"]').locator('#btn-speed'),
    ).toHaveClass(/done/);
    await page.screenshot({ path: testInfo.outputPath('interactive-844.png') });
    const menu = page.getByRole('button', { name: 'Playback controls', exact: true });
    await expect(menu).toBeVisible();
    // Mobile fullscreen includes the SAME keep-alive host and participant dialogs.
    await menu.click();
    await expect(menu).toHaveCount(0);
    await page
      .locator('.mobile-canvas-footer')
      .getByRole('button', { name: 'Fullscreen', exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => document.fullscreenElement?.hasAttribute('data-classroom-stage')),
      )
      .toBe(true);
    await expect(frame).toHaveAttribute('data-continuity-test', 'preserved');
    await page.getByRole('button', { name: '林老师', exact: true }).click();
    await expect(page.locator('[data-classroom-stage] [role="dialog"]')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => document.exitFullscreen());
    await expect(frame).toHaveAttribute('data-continuity-test', 'preserved');
    for (const size of [
      { width: 480, height: 320 },
      { width: 568, height: 320 },
      { width: 932, height: 430 },
    ]) {
      await page.setViewportSize(size);
      await expect(root).toHaveAttribute('data-mobile', 'true');
      await expect(frame).toHaveAttribute('data-continuity-test', 'preserved');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }

    await page.getByTestId('mobile-nav-directory').click();
    await page.getByTestId('scene-item').nth(6).click();
    await expect(page.getByTestId('mobile-roundtable')).toHaveAttribute('data-focused', 'true');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('mobile-roundtable')).toHaveAttribute('data-focused', 'true');
    await page.getByRole('button', { name: 'Start Quiz', exact: true }).click();
    const quiz = guide.scenes[6].content;
    if (quiz.type !== 'quiz' || !('questions' in quiz)) throw new Error('Guide quiz missing');
    for (const [index, question] of quiz.questions.entries()) {
      const value = index === 0 ? 'B' : question.answer[0];
      const option = question.options.find((option) => option.value === value)!;
      await page.getByText(option.label, { exact: true }).click();
    }
    await page.screenshot({ path: testInfo.outputPath('quiz-390.png') });
    await page.getByTestId('mobile-nav-chat').click();
    await expect(page.locator('.mobile-roundtable-input textarea')).toBeVisible();
    await page.getByTestId('mobile-nav-classroom').click();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: testInfo.outputPath('quiz-844.png') });
    await page.getByRole('button', { name: 'Submit Answers', exact: true }).click();
    await expect(page.getByTestId('course-end')).toBeVisible();
    await expect(page.getByTestId('course-end-reviewWrong')).toBeVisible();
    await expect(page.getByTestId('course-end-restart')).toBeVisible();
    await expect(page.getByTestId('course-end-doQuiz')).toHaveCount(0);
    await expect(page.getByTestId('course-end-result')).toContainText('2 / 3');
    // The card fades in over its entrance sequence; capture it once settled.
    await expect(page.getByTestId('course-end')).toHaveAttribute('data-skip', 'true');
    await expect(page.getByTestId('course-end-card')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('course-end-844.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('course-end-card')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('course-end-390.png') });
  });

  test('opens the whiteboard as a full-region viewer with zoom and an empty state', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const titleElement =
      guide.scenes[0].content.type === 'slide'
        ? guide.scenes[0].content.canvas.elements.find((element) => element.id === 'p1_title')
        : undefined;
    if (!titleElement) throw new Error('Guide title element missing');

    for (const withBoard of [false, true]) {
      const id = uniqueStageId(withBoard ? 'mobile-board' : 'mobile-board-empty');
      await page.goto('/');
      await seedServerDocument(page, {
        ...guide,
        stage: {
          ...guide.stage,
          id,
          ...(withBoard
            ? {
                whiteboard: [
                  {
                    id: `${id}-wb`,
                    viewportSize: 1000,
                    viewportRatio: 0.5625,
                    elements: [titleElement],
                  },
                ],
              }
            : {}),
        },
        scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
      });
      await setCurrentScene(page, id, guide.scenes[0].id);
      await page.goto(`/classroom/${id}`);
      await expect(page.locator('[data-playback-stage]')).toHaveAttribute('data-mobile', 'true');

      await page.getByRole('button', { name: 'Open Whiteboard', exact: true }).click();
      const board = page.getByTestId('mobile-whiteboard');
      await expect(board).toBeVisible();
      const region = await page.getByTestId('classroom-canvas-region').boundingBox();
      const boardBox = await board.boundingBox();
      // Fills the canvas region edge to edge rather than floating as an inset card.
      expect(Math.abs(boardBox!.width - region!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(boardBox!.height - region!.height)).toBeLessThanOrEqual(1);
      // The player chrome must not sit over the board's own header.
      await expect(page.locator('.mobile-canvas-chrome')).toHaveAttribute('data-visible', 'false');
      // Authoring tools stay on desktop.
      await expect(board.getByTitle('Clear Whiteboard', { exact: true })).toHaveCount(0);
      await expect(board.getByTitle('History', { exact: true })).toHaveCount(0);

      if (withBoard) {
        await expect(page.getByTestId('mobile-whiteboard-empty')).toHaveCount(0);
        const tools = page.getByTestId('mobile-whiteboard-view-tools');
        await expect(tools.locator('output')).toHaveText('100%');
        await tools.getByRole('button', { name: 'Zoom in', exact: true }).click();
        await expect(tools.locator('output')).toHaveText('125%');
        await tools.getByRole('button', { name: 'Reset View', exact: true }).click();
        await expect(tools.locator('output')).toHaveText('100%');
        for (const button of await tools.getByRole('button').all()) {
          const box = await button.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(44);
        }
      } else {
        await expect(page.getByTestId('mobile-whiteboard-empty')).toContainText(
          'No board notes yet',
        );
        await expect(page.getByTestId('mobile-whiteboard-view-tools')).toHaveCount(0);
      }

      await board.getByRole('button', { name: 'Minimize Whiteboard', exact: true }).click();
      await expect(board).toHaveCount(0);
    }
  });

  test('keeps the hosted classroom draft on rotation and returns through workspace navigation', async ({
    page,
  }, testInfo) => {
    test.skip(
      process.env.MOBILE_WORKSPACE_E2E !== 'true',
      'Run with both workbench runtime flags enabled',
    );
    test.setTimeout(60_000);
    const id = uniqueStageId('mobile-workspace');
    await page.goto('/');
    await seedServerDocument(page, {
      ...guide,
      stage: { ...guide.stage, id },
      scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/workspace?course=${id}`);
    await expect(page.locator('[data-playback-stage]')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
    await expect(page.locator('.mobile-roundtable-input textarea')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('workspace-lesson-390.png') });
    await page.locator('.mobile-roundtable-input textarea').fill('Keep this workspace question');
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('[data-playback-stage]')).toHaveAttribute('data-landscape', 'true');
    await page.screenshot({ path: testInfo.outputPath('workspace-lesson-844.png') });
    await page.getByTestId('mobile-nav-chat').click();
    await expect(page.locator('.mobile-roundtable-input textarea')).toHaveValue(
      'Keep this workspace question',
    );
    await page.getByTestId('mobile-nav-classroom').click();
    if ((await page.locator('.mobile-canvas-chrome[data-visible="true"]').count()) === 0) {
      await page.getByTestId('classroom-canvas-region').click({ position: { x: 20, y: 90 } });
    }
    await page
      .locator('.mobile-canvas-header')
      .getByRole('button', { name: 'Back', exact: true })
      .click();
    await expect(page.getByTestId('mobile-classroom-nav')).not.toBeVisible();
    await expect(page).toHaveURL(/\/workspace\/?$/);
    await expect(page.getByRole('main', { name: 'Back to home' })).toBeVisible();
  });
});
