import { test, expect } from '../fixtures/base';
import type { Locator } from '@playwright/test';

async function upwardTouchIsPrevented(panel: Locator) {
  return panel.evaluate((element) => {
    element.scrollTop = 0;
    const target = element.firstElementChild ?? element;
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touches = [{ identifier: 0, target, clientX: 100, clientY: y }];
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: touches },
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    touch('touchstart', 200);
    return touch('touchmove', 150);
  });
}

test.describe('course material navigation and scrolling', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const size of [
    { name: 'phone portrait', width: 390, height: 844, mobile: true },
    { name: 'phone landscape', width: 844, height: 390, mobile: true },
    { name: 'desktop', width: 1280, height: 900, mobile: false },
  ]) {
    test(`uploaded files remain scrollable and dismissible on ${size.name}`, async ({
      page,
      mockApi,
    }) => {
      const library = await mockApi.mockMaterials({ pollsUntilReady: 1 });
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
      await page.goto('/');
      const options = page.getByTestId('home-mobile-options');
      if (size.mobile) await page.getByTestId('home-options-open').click();
      if (size.mobile)
        await options.evaluate((element) =>
          Promise.all(
            element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
          ),
        );
      const optionsBox = size.mobile ? (await options.boundingBox())! : null;
      await page.getByTestId('course-material-button').click();
      if (optionsBox) {
        await expect
          .poll(async () => (await options.boundingBox())!.height)
          .toBeCloseTo(optionsBox.height, 0);
        await expect
          .poll(async () => (await options.boundingBox())!.y)
          .toBeCloseTo(optionsBox.y, 0);
      }
      await page.locator('input[type="file"][multiple]').setInputFiles(
        Array.from({ length: 5 }, (_, index) => ({
          name: `notes-${index}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from('Photosynthesis turns light into sugar.\n'.repeat(20)),
        })),
      );
      const chips = page.getByTestId('course-material-chip');
      await expect(chips).toHaveCount(5);
      await expect(
        page.locator('[data-testid="course-material-chip"][data-status="ready"]'),
      ).toHaveCount(5, { timeout: 15000 });
      const panel = size.mobile
        ? page.getByTestId('home-materials-body')
        : page
            .locator('[data-radix-popper-content-wrapper] > [data-state="open"]')
            .filter({ has: chips.first() });
      if (size.mobile) {
        await expect(
          options.getByRole('heading', { name: 'Course materials', exact: true }),
        ).toBeVisible();
        await expect(
          options.getByRole('button', { name: 'Back to course options', exact: true }),
        ).toBeVisible();
        await expect(
          options.getByRole('button', { name: 'All settings', exact: true }),
        ).not.toBeVisible();
        await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
      }
      await expect(panel).toBeVisible();
      // Compact fixtures can fit completely; a short viewport guarantees overflow.
      if (size.mobile)
        await page.setViewportSize({ width: size.width, height: Math.min(size.height, 500) });
      await expect
        .poll(() => panel.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(10);
      expect(await upwardTouchIsPrevented(panel)).toBe(false);
      await panel.hover();
      await page.mouse.wheel(0, 180);
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      if (size.mobile) {
        await expect(page.locator('body')).toHaveAttribute('data-scroll-locked');
        const materialBox = (await options.boundingBox())!;
        await options.getByRole('button', { name: 'Done', exact: true }).tap();
        await expect(panel).not.toBeVisible();
        await expect
          .poll(async () => (await options.boundingBox())!.height)
          .toBeCloseTo(materialBox.height, 0);
        await expect
          .poll(async () => (await options.boundingBox())!.y)
          .toBeCloseTo(materialBox.y, 0);
        await expect(
          options.getByRole('heading', { name: 'Course options', exact: true }),
        ).toBeVisible();
        const optionsBody = page.getByTestId('home-options-body');
        await expect
          .poll(() =>
            optionsBody.evaluate((element) => element.scrollHeight - element.clientHeight),
          )
          .toBeGreaterThan(0);
        expect(await upwardTouchIsPrevented(optionsBody)).toBe(false);
        await optionsBody.hover();
        await page.mouse.wheel(0, 120);
        await expect
          .poll(() => optionsBody.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        await expect(page.getByTestId('course-material-pill')).toContainText('Course materials');
        await expect(page.getByTestId('course-material-pill')).toContainText('5');
        await page.getByTestId('course-material-pill').tap();
        await expect(chips).toHaveCount(5);
        await options.getByRole('button', { name: 'Back to course options', exact: true }).tap();
        await expect(panel).not.toBeVisible();
        await page.getByTestId('course-material-pill').tap();
        await options.locator('[data-slot="dialog-close"]').tap();
        await expect(options).not.toBeVisible();
        await page.getByTestId('home-options-open').tap();
        await expect(
          options.getByRole('heading', { name: 'Course options', exact: true }),
        ).toBeVisible();
        await page.getByTestId('course-material-pill').tap();
        await expect(chips).toHaveCount(5);
      } else {
        await page.keyboard.press('Escape');
        await expect(panel).not.toBeVisible();
        await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked');
      }
      expect(library.materials.size).toBe(5);
      expect(library.deleted).toEqual([]);
    });
  }
});

test.describe('phone options motion', () => {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`open and page transitions respect ${reducedMotion}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion });
      await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
      await page.goto('/');
      await page.getByTestId('home-options-open').click();
      const options = page.getByTestId('home-mobile-options');
      await expect(options).toHaveCSS(
        'animation-name',
        reducedMotion === 'reduce' ? 'none' : 'home-options-enter',
      );
      await options.evaluate((element) =>
        Promise.all(
          element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
        ),
      );
      const before = await options.boundingBox();
      await page.getByTestId('course-material-button').click();
      const frame = options.locator('.home-options-page');
      await expect(frame).toHaveCSS(
        'animation-name',
        reducedMotion === 'reduce' ? 'none' : 'home-options-forward',
      );
      expect(await options.boundingBox()).toEqual(before);
      expect(
        await options.evaluate((element) =>
          element.getAnimations().some((animation) => animation.playState === 'running'),
        ),
      ).toBe(false);
      await options.getByRole('button', { name: 'Back to course options', exact: true }).click();
      await expect(frame).toHaveCSS(
        'animation-name',
        reducedMotion === 'reduce' ? 'none' : 'home-options-back',
      );
      await options.locator('[data-slot="dialog-close"]').click();
      await expect(options).not.toBeVisible();
      await page.getByTestId('home-options-open').click();
      await expect(
        options.getByRole('heading', { name: 'Course options', exact: true }),
      ).toBeVisible();
    });
  }
});
