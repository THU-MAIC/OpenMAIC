import { test, expect } from '../fixtures/base';
import { seedServerDocument, uniqueStageId, setCurrentScene } from '../fixtures/server-seed';
import guide from '../../public/guide-course/zh.json';

test.describe('Mobile classroom with the shared playback surface', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

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
    await expect(page.getByTestId('mobile-classroom-lecture')).toBeVisible();
    const slide = await page.getByTestId('classroom-canvas-region').boundingBox();
    expect(slide!.width).toBeGreaterThan(350);
    expect(slide!.height).toBeLessThan(250);
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const button of await page.locator('[data-mobile-toolbar] button:visible').all()) {
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .locator('.mobile-roundtable-input textarea')
      .fill('A question to keep across rotation');
    await page.getByRole('button', { name: 'Participants', exact: true }).click();
    await expect(page.getByTestId('mobile-roundtable')).toHaveAttribute('data-focused', 'true');
    await page.getByRole('button', { name: 'Participants', exact: true }).click();
    await expect(page.getByTestId('mobile-roundtable')).toHaveAttribute('data-focused', 'false');
    await page.screenshot({ path: testInfo.outputPath('lesson-390.png') });
    await page.setViewportSize({ width: 390, height: 400 });
    await expect(page.locator('.mobile-roundtable-input textarea')).toBeInViewport();
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
    await page.getByTestId('mobile-panel-close').click();
    await expect(frame).toBeVisible();
    await expect(page.getByTestId('mobile-classroom-nav')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(
      page.frameLocator('iframe[title^="Interactive Scene"]').locator('#btn-speed'),
    ).toHaveClass(/done/);
    await page.screenshot({ path: testInfo.outputPath('interactive-844.png') });
    // Mobile fullscreen includes the SAME keep-alive host and participant dialogs.
    await page.locator('.mobile-canvas-menu').click();
    await page
      .locator('.mobile-canvas-header')
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
    await page.getByTestId('mobile-panel-close').click();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: testInfo.outputPath('quiz-844.png') });
    await page.getByRole('button', { name: 'Submit Answers', exact: true }).click();
    await expect(page.getByTestId('course-end')).toBeVisible();
    await expect(page.getByTestId('course-end-reviewWrong')).toBeVisible();
    await expect(page.getByTestId('course-end-restart')).toBeVisible();
    await expect(page.getByTestId('course-end-doQuiz')).toHaveCount(0);
    await expect(page.getByTestId('course-end-result')).toContainText('2 / 3');
    await page.screenshot({ path: testInfo.outputPath('course-end-844.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('course-end-390.png') });
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
    await page.screenshot({ path: testInfo.outputPath('workspace-lesson-844.png') });
    await page.getByTestId('mobile-nav-chat').click();
    await expect(page.locator('.mobile-roundtable-input textarea')).toHaveValue(
      'Keep this workspace question',
    );
    await page.getByTestId('mobile-panel-close').click();
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
