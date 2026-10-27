import { test, expect } from '../fixtures/base';

// CDP dispatches browser touch input so the regression checks native scrolling,
// in addition to checking whether the document boundary cancels touchmove.
test.describe('phone settings horizontal navigation', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 844 } });

  for (const direction of ['ltr', 'rtl'] as const) {
    test(`allows horizontal swipes with vertical drift (${direction})`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
      await page.goto('/');
      await page.getByTestId('home-options-open').click();
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      const nav = page.getByTestId('settings-nav-general').locator('..');
      await page.evaluate((dir) => {
        document.documentElement.dir = dir;
      }, direction);
      await expect
        .poll(() => nav.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeGreaterThan(20);

      expect(
        await nav.evaluate((element) => {
          const target = element.querySelector('button')!;
          const touch = (type: string, x: number, y: number) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            const touches = [{ identifier: 0, target, clientX: x, clientY: y }];
            Object.defineProperties(event, {
              touches: { value: touches },
              changedTouches: { value: touches },
            });
            target.dispatchEvent(event);
            return event.defaultPrevented;
          };
          element.scrollLeft =
            (element.scrollWidth - element.clientWidth) /
            (getComputedStyle(element).direction === 'rtl' ? -2 : 2);
          touch('touchstart', 200, 100);
          const leftBlocked = touch('touchmove', 150, 103);
          touch('touchstart', 150, 100);
          const rightBlocked = touch('touchmove', 200, 97);
          element.scrollLeft = 0;
          return { leftBlocked, rightBlocked };
        }),
      ).toEqual({ leftBlocked: false, rightBlocked: false });

      const bounds = (await nav.boundingBox())!;
      const startX = bounds.x + bounds.width * (direction === 'ltr' ? 0.8 : 0.2);
      const distance = bounds.width * (direction === 'ltr' ? -0.6 : 0.6);
      const y = bounds.y + bounds.height / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
      });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX + (distance * step) / 8, y: y + step / 2 }],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect
        .poll(() => nav.evaluate((element) => Math.abs(element.scrollLeft)))
        .toBeGreaterThan(10);
      await cdp.detach();
      await page.getByTestId('settings-nav-general').click();
      await expect(page.getByTestId('settings-nav-general')).toHaveClass(/bg-primary/);
    });
  }
});
