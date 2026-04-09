import type { Page, Locator } from '@playwright/test';

export class GenerationPreviewPage {
  readonly page: Page;
  readonly stepTitle: Locator;
  readonly backButton: Locator;
  readonly reviewTitle: Locator;
  readonly confirmOutlinesButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.stepTitle = page.locator('h2');
    this.backButton = page.getByRole('button', { name: /back|返回/i });
    this.reviewTitle = page.getByRole('heading', {
      name: /Review your outline|审阅课程大纲|アウトラインを確認|Проверьте план курса/i,
    });
    this.confirmOutlinesButton = page.getByRole('button', {
      name: /Confirm and generate course|确认并生成课程|確認してコースを生成|Подтвердить и сгенерировать курс/i,
    });
  }

  async goto() {
    await this.page.goto('/generation-preview');
  }

  async waitForRedirectToClassroom() {
    await this.page.waitForURL(/\/classroom\//, { timeout: 30_000 });
  }

  async waitForOutlineReview() {
    await this.reviewTitle.waitFor({ state: 'visible' });
  }

  async confirmOutlines() {
    await this.confirmOutlinesButton.click();
  }
}
