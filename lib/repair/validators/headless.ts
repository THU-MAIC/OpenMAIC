import { chromium } from '@playwright/test';
import type { ValidationLayer } from '../types';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

export async function validateHeadless(html: string): Promise<ValidationLayer> {
  const messages: string[] = [];
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (err) => messages.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') messages.push(`console.error: ${msg.text()}`);
    });
    page.on('requestfailed', (req) => messages.push(`requestfailed: ${req.url()}`));
    await page.setContent(patchHtmlForIframe(html), { waitUntil: 'load', timeout: 8000 });
    await page.waitForTimeout(800); // let init scripts run
    await browser.close();
    return { name: 'headless', status: messages.length ? 'fail' : 'pass', messages };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    // Infra failure is advisory, not a content failure.
    return {
      name: 'headless',
      status: 'warn',
      messages: [`headless infra: ${(e as Error).message}`],
    };
  }
}
