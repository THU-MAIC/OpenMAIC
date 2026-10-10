import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const TEST_STAGE_PREFIX = 'e2e-test-stage';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/** Seed a course with 3 slide scenes through the server, as this page's owner. */
async function seedDatabase(page: import('@playwright/test').Page): Promise<string> {
  // Inject settings before navigating so it's available immediately on load
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  const stageId = uniqueStageId(TEST_STAGE_PREFIX);
  const now = Date.now();
  // Scene content uses SlideContent shape: { type: 'slide', canvas: Slide }
  const makeSlideContent = (title: string, elId: string) => ({
    type: 'slide',
    canvas: {
      id: `slide-${elId}`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: defaultTheme,
      elements: [
        {
          type: 'text',
          id: `el-${elId}`,
          content: title,
          left: 50,
          top: 50,
          width: 900,
          height: 100,
        },
      ],
    },
  });
  const titles = ['基本概念', '光反应', '暗反应'];
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: '光合作用',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: titles.map((title, order) => ({
      id: `scene-${order}`,
      stageId,
      type: 'slide',
      title,
      order,
      content: makeSlideContent(title, String(order)),
      createdAt: now,
      updatedAt: now,
    })),
    // Empty outlines = all scenes generated, no pending work
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  return stageId;
}

test.describe('Classroom Interaction', () => {
  let stageId: string;

  test.beforeEach(async ({ page }) => {
    stageId = await seedDatabase(page);
  });

  test('loads classroom and switches scenes', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    // Sidebar shows 3 scenes
    await expect(classroom.sidebarScenes).toHaveCount(3, { timeout: 10_000 });

    // First scene title visible
    await expect(classroom.getSceneTitle(0)).toContainText('基本概念');

    // Click second scene
    await classroom.clickScene(1);

    // Verify second scene is now active — heading in the top bar shows the current scene name
    await expect(page.getByRole('heading', { name: '光反应' })).toBeVisible();
  });

  test('caps and restores the non-presentation roundtable draft height', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await page.keyboard.press('T');
    const textarea = page.getByPlaceholder('Type your message...', { exact: true });
    const inputStage = page.getByTestId('roundtable-non-presentation-input-stage');
    await expect(textarea).toBeVisible();

    const readMetrics = () =>
      textarea.evaluate((element) => {
        const computedStyle = getComputedStyle(element);
        const containingPanel = element.closest<HTMLElement>(
          '[data-testid="roundtable-non-presentation-input-panel"]',
        );
        if (!containingPanel) {
          throw new Error('Could not find the non-presentation roundtable input panel');
        }

        const overflowHiddenCard = containingPanel.closest<HTMLElement>(
          '[data-testid="roundtable-non-presentation-card"]',
        );
        if (!overflowHiddenCard) {
          throw new Error('Could not find the roundtable overflow-hidden card');
        }

        const cardStyle = getComputedStyle(overflowHiddenCard);
        if (
          cardStyle.overflow !== 'hidden' ||
          cardStyle.overflowX !== 'hidden' ||
          cardStyle.overflowY !== 'hidden'
        ) {
          throw new Error('The roundtable clipping card must hide overflow');
        }

        const panelRect = containingPanel.getBoundingClientRect();
        const cardRect = overflowHiddenCard.getBoundingClientRect();
        return {
          computedHeight: computedStyle.height,
          computedMaxHeight: computedStyle.maxHeight,
          computedOverflowY: computedStyle.overflowY,
          computedFieldSizing: computedStyle.getPropertyValue('field-sizing'),
          inlineHeight: element.style.height,
          inlineFieldSizing: element.style.getPropertyValue('field-sizing'),
          boundingRectHeight: element.getBoundingClientRect().height,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          containingPanelHeight: panelRect.height,
          panelTop: panelRect.top,
          cardTop: cardRect.top,
          cardHeight: cardRect.height,
          cardOverflow: cardStyle.overflow,
        };
      });

    await expect(inputStage).toHaveCSS('transform', 'none');
    const initialMetrics = await readMetrics();
    const longDraft = Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join('\n');

    await textarea.fill(longDraft);
    await expect.poll(async () => (await readMetrics()).inlineHeight).toBe('100px');
    const longDraftMetrics = await readMetrics();

    await test.info().attach('roundtable textarea pre-post metrics', {
      body: JSON.stringify({ initialMetrics, longDraftMetrics }, null, 2),
      contentType: 'application/json',
    });

    const metricSummary = JSON.stringify({ initialMetrics, longDraftMetrics });
    expect(
      longDraftMetrics.panelTop,
      `Roundtable input panel must stay inside its overflow-hidden card: ${metricSummary}`,
    ).toBeGreaterThanOrEqual(longDraftMetrics.cardTop);
    expect(longDraftMetrics.cardOverflow).toBe('hidden');
    expect(
      longDraftMetrics.computedFieldSizing,
      `Roundtable textarea metrics: ${metricSummary}`,
    ).not.toBe('content');
    expect(
      longDraftMetrics.inlineFieldSizing,
      `Roundtable textarea metrics: ${metricSummary}`,
    ).toBe('');
    expect(longDraftMetrics.inlineHeight).toBe('100px');
    expect(longDraftMetrics.computedMaxHeight).toBe('100px');
    expect(longDraftMetrics.computedOverflowY).toBe('auto');
    expect(longDraftMetrics.boundingRectHeight).toBeLessThanOrEqual(100);
    expect(longDraftMetrics.scrollHeight).toBeGreaterThan(longDraftMetrics.clientHeight);

    await textarea.fill('Short line');
    await expect
      .poll(async () => (await readMetrics()).clientHeight)
      .toBeLessThan(longDraftMetrics.clientHeight);
    await expect.poll(async () => (await readMetrics()).inlineHeight).not.toBe('100px');

    await textarea.fill(longDraft);
    await page.keyboard.press('Escape');
    await expect(textarea).toBeHidden();

    await page.keyboard.press('T');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(longDraft);
    await expect.poll(async () => (await readMetrics()).inlineHeight).toBe('100px');
  });

  test('keeps body spacing stable for header menus and settings modal', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    const initialBodySpacing = await page.evaluate(() => {
      const styles = getComputedStyle(document.body);
      return {
        paddingRight: styles.paddingRight,
        marginRight: styles.marginRight,
      };
    });

    const expectBodyScrollState = async (locked: boolean) => {
      await expect
        .poll(() =>
          page.evaluate(() => ({
            locked: document.body.hasAttribute('data-scroll-locked'),
            paddingRight: getComputedStyle(document.body).paddingRight,
            marginRight: getComputedStyle(document.body).marginRight,
          })),
        )
        .toEqual({
          locked,
          paddingRight: initialBodySpacing.paddingRight,
          marginRight: initialBodySpacing.marginRight,
        });
    };

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'English' })).toBeVisible();
    await expectBodyScrollState(false);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'English' })).toBeHidden();

    await page.getByRole('button', { name: 'Theme' }).click();
    await expect(page.getByRole('menuitem', { name: 'Light' })).toBeVisible();
    await expectBodyScrollState(false);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Light' })).toBeHidden();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expectBodyScrollState(true);
  });
});
