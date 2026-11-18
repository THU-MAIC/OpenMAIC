import { test, expect, type Page } from '../fixtures/base';

/**
 * The workspace on a phone: a bar over the canvas, and the rail as a sheet.
 *
 * The workspace route is gated on the workbench and agent-runtime flags, which
 * CI does not set, so this runs only where both are on:
 *   MOBILE_WORKSPACE_E2E=true NEXT_PUBLIC_WORKBENCH_ENABLED=true \
 *   OPENMAIC_AGENT_RUNTIME_ENABLED=true pnpm exec playwright test mobile-workbench-home
 */
test.describe('Workspace navigation on a phone', () => {
  test.skip(
    process.env.MOBILE_WORKSPACE_E2E !== 'true',
    'Run with the workbench and agent-runtime flags enabled',
  );
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const noOverflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  test('keeps the focused home composer at a phone-safe font size', async ({ page }) => {
    await page.goto('/workspace');
    const prompt = page.getByTestId('pro-launch-prompt');
    await prompt.tap();
    await expect(prompt).toBeFocused();
    expect(
      await prompt.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    expect(await noOverflow(page)).toBe(true);
  });

  test('picks skills by touch with and without initial editor focus', async ({ page }) => {
    for (const [focusFirst, skill] of [
      [true, 'deep-interactive'],
      [false, 'workshop-style'],
    ] as const) {
      await page.goto('/workspace');
      const prompt = page.getByTestId('pro-launch-prompt');
      if (focusFirst) await prompt.tap();
      else await prompt.blur();
      await prompt.evaluate((el) => {
        el.addEventListener('blur', () => el.setAttribute('data-lost-focus', 'true'));
      });
      await page.getByTestId('pro-launch-skill').tap();
      await expect(prompt).toBeFocused();
      const option = page.getByTestId(`workbench-skill-option-${skill}`);
      const label = await option.locator('span.truncate').innerText();
      await option.tap();
      await expect(prompt.locator('[data-chip="skill"]')).toHaveText(label);
      await expect(page.getByTestId('workbench-skill-menu')).toHaveCount(0);
      await expect(prompt).toBeFocused();
      await expect(prompt).not.toHaveAttribute('data-lost-focus', 'true');
    }
  });

  test('moves the new conversation composer as the phone keyboard opens', async ({ page }) => {
    await page.goto('/workspace');
    await page.getByTestId('pro-mobile-menu').tap();
    await page.getByTestId('pro-mobile-drawer').getByTestId('pro-nav-my-courses').tap();
    await expect(page.getByTestId('workspace-courses-search')).toBeVisible();
    await page.getByTestId('pro-mobile-new-session').tap();
    await expect(page.getByTestId('pro-launch-prompt')).toBeFocused();

    // Mobile Safari shrinks the visual viewport while leaving layout vh unchanged.
    const composer = page.locator('.ws-composer');
    const bottom = () => composer.evaluate((el) => el.getBoundingClientRect().bottom);
    const section = page.getByTestId('pro-workspace-first-screen');
    const padding = () => section.evaluate((el) => getComputedStyle(el).paddingTop);
    const initialPadding = await padding();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 395 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    const home = page.getByTestId('pro-workspace-home');
    await expect(home).toHaveCSS('overflow-y', 'clip');
    const gap = async () => 395 - (await bottom());
    await expect.poll(gap).toBeCloseTo(12, -1);
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'offsetTop', {
        configurable: true,
        value: 180,
      });
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => 180 + (await gap())).toBeCloseTo(12, -1);
    const bar = page.getByTestId('pro-mobile-bar');
    await expect.poll(() => bar.evaluate((el) => el.getBoundingClientRect().top)).toBe(180);
    await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, 'offsetTop');
      Reflect.deleteProperty(window.visualViewport!, 'height');
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(home).toHaveCSS('overflow-y', 'auto');
    await expect.poll(padding).toBe(initialPadding);
  });

  test('reaches every destination from the bar and its sheet', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/workspace');
    const bar = page.getByTestId('pro-mobile-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('pro-nav-rail')).toBeHidden();

    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await noOverflow(page)).toBe(true);
      for (const id of ['pro-mobile-menu', 'pro-mobile-new-session']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });

    const drawer = page.getByTestId('pro-mobile-drawer');
    const open = async () => {
      await page.getByTestId('pro-mobile-menu').click();
      await expect(drawer).toBeVisible();
    };

    // My courses: the sheet closes on the way, and the toolbar stays on screen.
    await open();
    await expect(drawer.locator('kbd')).toHaveCount(0);
    await drawer.getByTestId('pro-nav-my-courses').click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('workspace-courses-search')).toBeVisible();
    await expect(page.getByTestId('workspace-courses-import')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('workspace-courses-search-field')).toBeInViewport({ ratio: 1 });
    expect(await noOverflow(page)).toBe(true);

    // Knowledge base.
    await open();
    await drawer.getByTestId('pro-nav-library').click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('pro-workspace-library')).toBeVisible();

    // Search opens the shell's palette.
    await open();
    await drawer.getByTestId('pro-nav-search').click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('workspace-search-input')).toBeVisible();
    await page.keyboard.press('Escape');

    // The mark goes home.
    await page.getByTestId('pro-mobile-home').click();
    await expect(page.getByTestId('pro-workspace-home')).toBeVisible();

    // The sheet closes from its button, its overlay and Escape.
    await open();
    await drawer.getByTestId('pro-nav-drawer-close').click();
    await expect(drawer).toHaveCount(0);
    await open();
    await page.mouse.click(380, 400);
    await expect(drawer).toHaveCount(0);
    await open();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('closes when touched while the sheet is still sliding in', async ({ page }) => {
    // The sheet travels over 200ms, so a press aimed at its close button during
    // that time lands on the panel itself. It used to do nothing at all — the
    // press and the release got different targets, so no click was dispatched.
    await page.goto('/workspace');
    // Hold the entrance halfway through so runner latency cannot turn this
    // into a tap on an already-open navigation item.
    await page.addStyleTag({
      content: `
      [data-testid="pro-mobile-drawer"][data-state="open"] {
        animation-delay: -100ms;
        animation-play-state: paused;
      }
    `,
    });
    await page.getByTestId('pro-mobile-menu').tap();
    const drawer = page.getByTestId('pro-mobile-drawer');
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    await page.touchscreen.tap(box!.x + box!.width - 8, 300);
    await expect(drawer).toHaveCount(0);
  });

  test('keeps the desktop rail and no bar from `md` up', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/workspace');
    await expect(page.locator('[data-testid="pro-workspace"]')).toBeVisible();
    await expect(page.getByTestId('pro-mobile-bar')).toBeHidden();
    // Folded or not, one of the rail's two forms is on screen.
    await expect(
      page.locator(
        '[data-testid="pro-nav-rail"]:visible, [data-testid="pro-nav-rail-mini"]:visible',
      ),
    ).toHaveCount(1);
  });
});
