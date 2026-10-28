import { expect, test } from '@playwright/test';

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
});

for (const path of ['/', '/classroom/viewport-safe-area-check']) {
  test(`${path} leaves cutout avoidance to the browser`, async ({ page }) => {
    await page.goto(path);

    // Check emitted metadata, not simulated CSS insets: cover opts every route
    // into cutouts even when that route has no safe-area-aware controls.
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveCount(1);
    const content = await viewport.getAttribute('content');
    expect(content).toContain('width=device-width');
    expect(content).toContain('initial-scale=1');
    expect(content).not.toMatch(/viewport-fit\s*=\s*cover/);
    expect(content).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/);
  });
}
