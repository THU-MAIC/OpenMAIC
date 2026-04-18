import { chromium, type Browser, type Page } from '@playwright/test';
import type { PPTElement } from '@/lib/types/slides';
import { mkdirSync } from 'fs';
import { join } from 'path';

const VIEWPORT = { width: 1000, height: 563 };

let browser: Browser | null = null;
let page: Page | null = null;

/**
 * Initialize Playwright browser (reused across captures).
 */
export async function initCapture(baseUrl: string): Promise<void> {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  page = await context.newPage();

  await page.goto(`${baseUrl}/eval/whiteboard`);
  // Wait for the page to signal readiness
  await page.waitForFunction(
    () => (window as unknown as Record<string, unknown>).__evalReady === true,
  );
}

/**
 * Capture a screenshot of the whiteboard with the given elements.
 * Returns the path to the saved screenshot.
 */
export async function captureWhiteboard(
  elements: PPTElement[],
  outputDir: string,
  filename: string,
): Promise<string> {
  if (!page) throw new Error('Capture not initialized. Call initCapture() first.');

  // Inject elements into the page
  await page.evaluate(
    (els: unknown[]) => {
      const setter = (window as unknown as Record<string, (els: unknown[]) => void>).__setElements;
      setter(els);
    },
    elements as unknown as unknown[],
  );

  // Wait for rendering to stabilize (fonts, KaTeX, images)
  await page.waitForTimeout(1500);

  mkdirSync(outputDir, { recursive: true });
  const filepath = join(outputDir, filename);

  await page.screenshot({ path: filepath, clip: { x: 0, y: 0, width: 1000, height: 563 } });

  return filepath;
}

/**
 * Close the browser.
 */
export async function closeCapture(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}
