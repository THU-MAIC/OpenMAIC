import type { Page, Locator } from '@playwright/test';

export class GenerationPreviewPage {
  readonly page: Page;
  readonly stepTitle: Locator;
  readonly backButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.stepTitle = page.locator('h2');
    this.backButton = page.getByRole('button', { name: /back|返回/i });
  }

  async goto() {
    await this.page.goto('/generation-preview');
  }

  async waitForRedirectToClassroom() {
    await this.page.waitForURL(/\/classroom\//, { timeout: 30_000 });
  }
}
